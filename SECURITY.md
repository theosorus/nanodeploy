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
- **You own every account.** Accounts are created by you in Pocket ID. There is
  no public signup anywhere in the stack.

## What is enforced

| Boundary | How |
|---|---|
| Apps cannot reach Docker | apps sit on `nanodeploy_apps`, which only carries Caddy and Postgres. The socket proxies, Sablier, tinyauth and the control plane are on `nanodeploy_edge` and unreachable from an app. |
| Apps cannot escalate in their container | non-root user, `cap_drop: ALL`, `no-new-privileges`, read-only root filesystem (only the `/data` volume and a `noexec` `/tmp` are writable), 256 MB memory cap, 128 pid cap. |
| Apps cannot read each other's data | one Postgres database and one role per app, `CONNECT` revoked from `public` on every database including the platform's own and the `postgres` maintenance database. |
| Identity cannot be forged | Caddy strips every inbound `Remote-*` header before forward-auth re-injects it, and `request_header` is explicitly ordered before `forward_auth`. |
| The console cannot be driven by a stranger | every `/api/*` route requires either the exact deploy token (compared in constant time) or a browser session in the admin group. |
| The console cannot be driven from another website | state-changing requests that are not token-authenticated must be same-origin. `multipart/form-data` is a CORS simple request, so `/api/deploy` would otherwise be reachable by cross-site fetch using an admin's cookie. |
| A broken app cannot take the gateway down | a site file that Caddy refuses is rolled back and the previous config reloaded, so one bad app never freezes route updates for the others. Platform subdomains (`deploy`, `auth`, `id`, `www`) are reserved. |
| Docker cannot be reached by Sablier | Sablier talks to its own socket proxy, allowed only to list, inspect, start and stop. It cannot build images or exec. |

## Known limits, accepted on purpose

These are real. Decide whether they matter for your setup before you deploy.

- **Apps see each other on the shared network.** Any app can open a TCP
  connection to any other app and to Caddy. There is no per-app network. Do not
  host an app open to untrusted users next to something sensitive.
- **App secrets are stored in clear text.** Environment variables and each app's
  Postgres password live in the `apps` table of the control database. Anyone who
  can read that database, or a backup of it, reads the secrets. Encrypt your
  backups.
- **The control plane is root-equivalent.** It can build images and exec into
  containers through its socket proxy. Compromising it compromises the host.
  Whoever is in the admin group has that power.
- **Until you pick an admin group, every account is an administrator.** A fresh
  install is single-user, so this is fine while you are alone. The dashboard
  refuses to create a second account until you have chosen the group, and warns
  in red until then.
- **There is no rate limiting.** The deploy token is 48 hex characters and
  compared in constant time, so guessing it online is not realistic, but nothing
  slows an attacker down. Putting the console behind Cloudflare Access, or any
  other outer layer, is recommended and cheap.
- **The waiting page is served with a 200.** When a sleeping app is woken, the
  first request gets Sablier's HTML page instead of the app's answer. Clients
  must retry; the template's `src/client.ts` does. This is a correctness trap
  more than a security one, but an API consumer that ignores it will misbehave.
- **No automatic backups.** A single shared Postgres is a single point of loss
  for every app. See the README.

## Rotating secrets

- `DEPLOY_TOKEN`: change it in `.env`, then `docker compose up -d caddy
  control-plane`. Caddy matches the literal token, so both containers need it.
- `POSTGRES_PASSWORD`: change it in Postgres first (`ALTER ROLE postgres
  PASSWORD ...`), then in `.env`, then restart the control plane.
- `POCKETID_ENCRYPTION_KEY`: do not rotate casually, Pocket ID encrypts stored
  data with it.
- An app's database password is regenerated only if you delete its row; there is
  no rotation command yet.
