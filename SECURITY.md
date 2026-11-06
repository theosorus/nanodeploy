# Security

Nanodeploy runs arbitrary code you wrote, on a machine in your home, behind an
identity provider. This page says what it defends against, what it does not,
and how to report a problem.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository ("Security" tab →
"Report a vulnerability"). Please do not open a public issue for anything that
would let someone reach a stranger's server. Expect a first answer within a few
days; this is a hobby project, not a vendor.

## What the design assumes

- **The gateway is the only way in.** No app container publishes a port. Caddy
  is the sole process bound to the host, on `127.0.0.1` only, and something else
  (a Cloudflare tunnel, a reverse proxy) terminates TLS in front of it.
- **The control plane is trusted, apps are not.** The control plane builds
  images and drives Docker, which is equivalent to root on the host. Apps are
  treated as hostile code that happens to be yours.
- **You own every account.** Accounts are created by an administrator, from the
  dashboard or the first-start link in the control plane's logs. There is
  no public signup anywhere in the stack.

## What is enforced

| Boundary | How |
|---|---|
| Apps cannot reach Docker or the control plane | apps sit only on `nanodeploy_apps`, which carries Caddy and Postgres and nothing else. The socket proxies, Sablier, gate and the control plane share no network with any app, so an app cannot reach `control-plane:8000` and forge `Remote-*` headers to drive the platform. |
| Apps cannot escalate in their container | non-root user, `cap_drop: ALL`, `no-new-privileges`, read-only root filesystem (only the `/data` volume and a `noexec` `/tmp` are writable), 256 MB memory cap, 128 pid cap. |
| Apps cannot read each other's data | one Postgres database and one role per app, `CONNECT` revoked from `public` on every database including the platform's own and the `postgres` maintenance database. |
| Identity cannot be forged | Caddy strips every inbound `Remote-*` header before forward-auth re-injects it, and `request_header` is explicitly ordered before `forward_auth`. |
| The console cannot be driven by a stranger | every `/api/*` route requires the exact deploy token (compared in constant time), a per-app deploy key, or a browser session of an administrator. |
| A deploy key cannot reach beyond its app | a key (`ndd_` + 43 random characters) is stored as a SHA-256 hash and bound to one slug. It opens three routes only: deploying a bundle whose `app.yaml` names that slug, reading that app's logs, and `/api/me`. An unknown or revoked key is refused outright and never falls back to the session check. Deleting an app revokes its keys. |
| A session cannot be replayed on another host | gate keeps a root session on the auth host and gives each other host its own session, through a one-time code (60 s, single use, bound to that host). Its cookies are `__Host-` cookies, so the browser never sends one host's session to another. A cookie an app might copy is useless anywhere else, and Caddy removes it from the requests an app receives anyway, along with any `tinyauth-*` cookie left from an older install and any `ndk_` access key. Signing out ends the root session and every host session made from it. |
| The console needs a recent, administrator sign-in | gate lets a browser reach `deploy.` only for an account flagged as administrator that proved who it is within the last 12 hours; the control plane checks the flag again, from the database, on every request. Personal access keys never open the console. |
| Passwords resist offline guessing and online guessing | scrypt (N=2^15, r=8, p=1, per-password salt). Ten characters minimum, the most common passwords refused. After five failures per address or per account, each attempt doubles the wait, up to five minutes. An unknown username takes as long to refuse as a wrong password. |
| Sign-in pages cannot be abused from another site | every POST on the auth host must carry the auth host's own Origin; pages refuse framing and load scripts from the auth host only (CSP). Redirects after sign-in only go to the apps domain, on the scheme and port in use. |
| Access rules cannot be dodged with odd paths | protected paths are compared case-insensitively, percent-decoded and with dot segments resolved, which can only make a path look more protected, never less. Apps also check the role in their own code (`requireRole`). |
| gate cannot read secrets | its database role sees its own schema and six columns of the apps table (slug, name, access, groups, roles, protect): never env values or app database passwords. It has no Docker access. |
| The console cannot be driven from another website | state-changing requests that are not token-authenticated must be same-origin. `multipart/form-data` is a CORS simple request, so `/api/deploy` would otherwise be reachable by cross-site fetch using an admin's cookie. |
| A broken app cannot take the gateway down | a site file that Caddy refuses is rolled back and the previous config reloaded, so one bad app never freezes route updates for the others. Platform subdomains (`deploy`, `auth`, `id`, `www`) are reserved. |
| Docker cannot be reached by Sablier | Sablier talks to its own socket proxy, allowed only to list, inspect, start and stop. It cannot build images or exec. |

## Known limits, accepted on purpose

These are real. Decide whether they matter for your setup before you deploy.

- **Apps see each other on the shared network.** Any app can open a TCP
  connection to any other app and to Caddy. There is no per-app network. Do not
  host an app open to untrusted users next to something sensitive.
- **Apps reach the internet.** The apps network is not `internal`, because an
  app may legitimately call an external API (that is why `env` exists). The flip
  side is that a compromised app can send data out. Nothing on this platform
  stops it.
- **Apps can reach other services on the same host.** Through the Docker
  network gateway, an app can connect to anything else you run on the machine
  that listens on `0.0.0.0`, including services outside nanodeploy and the host's
  own SSH. Bind your other services to `127.0.0.1` or a non-Docker interface, or
  firewall the Docker bridge, if that matters to you. Apps cannot reach the
  control plane, Sablier, tinyauth or the Docker socket proxies: those sit on a
  network no app is connected to.
- **App secrets are stored in clear text.** Environment variables and each app's
  Postgres password live in the `apps` table of the control database. Anyone who
  can read that database, or a backup of it, reads the secrets. Encrypt your
  backups.
- **The control plane is root-equivalent.** It can build images and exec into
  containers through its socket proxy. Compromising it compromises the host.
  Every administrator has that power.
- **Rate limiting covers sign-in, not the API.** The deploy token is 48 hex
  characters and deploy keys 256 random bits, so guessing them online is not
  realistic, but nothing slows such an attempt. Putting the console behind
  Cloudflare Access, or any other outer layer, is recommended and cheap
  (exclude `auth.` and the apps, not just `deploy.`).
- **Rate limits live in memory.** Restarting gate resets the counters.
- **No email.** Nanodeploy sends no mail: an invitation or a forgotten password
  is a link an administrator hands over. A second factor (TOTP) is not there yet;
  a passkey is the strong option.
- **The waiting page is served with a 200.** When a sleeping app is woken, the
  first request gets Sablier's HTML page instead of the app's answer. Clients
  must retry; the template's `src/client.ts` does. This is a correctness trap
  more than a security one, but an API consumer that ignores it will misbehave.
- **Database snapshots sit on the server, in clear.** Before each migration the
  app's database is dumped to `APPS_DIR/.snapshots/<slug>/` (directory 0700,
  files 0600, the last three kept). Caddy mounts `APPS_DIR` read-only but only
  ever serves `<slug>/current/dist`. Include the directory in your encrypted
  backups, or exclude it on purpose.
- **No automatic backups.** A single shared Postgres is a single point of loss
  for every app. See the README.

## Rotating secrets

- `DEPLOY_TOKEN`: change it in `.env`, then `docker compose up -d caddy
  control-plane`. Caddy matches the literal token, so both containers need it.
  Prefer deploy keys for anything that leaves the server.
- A deploy key: revoke it in the app's panel and create a new one. Revoking
  takes effect on the next request.
- `POSTGRES_PASSWORD`: change it in Postgres first (`ALTER ROLE postgres
  PASSWORD ...`), then in `.env`, then restart the control plane.
- `GATE_DB_PASSWORD`: change it in `.env`, then `docker compose up -d
  control-plane gate`. The control plane sets it on the database role at start.
- `POCKETID_ENCRYPTION_KEY`: only for an upgrade still importing from Pocket ID;
  do not rotate casually, Pocket ID encrypts stored
  data with it.
- An app's database password is regenerated only if you delete its row; there is
  no rotation command yet.
