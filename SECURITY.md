# Security

Nanodeploy runs arbitrary code you wrote, on a machine in your home, behind an
identity provider. This page says what it defends against, what it does not,
and how to report a problem.

Security review and regression evidence: [7 November 2026](docs/security-audit-2026-11-07.md).
Read the [security upgrade procedure](docs/UPGRADING.md#security-upgrade-7-november-2026)
before installing this version over an existing deployment.

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
| Apps cannot reach Docker, the control plane, neighbouring backends or private host/LAN services directly | each app joins only its own internal `nanodeploy_app_<slug>` bridge, with no IPv4 host gateway and IPv6 disabled. Only Caddy, Postgres and the filtered egress proxy join that bridge. No app port is published. |
| Public API calls remain possible | apps and builders use an HTTP/HTTPS proxy that permits public destinations on ports 80/443 only, refuses private, loopback and metadata addresses, validates every DNS answer and pins the selected IP. Proxy variables are platform-owned; Node 24 and npm use them automatically. Other HTTP libraries must support these variables. |
| Apps cannot escalate in their container | non-root user, `cap_drop: ALL`, `no-new-privileges`, read-only root filesystem (only the `/data` volume and a `noexec` `/tmp` are writable), 256 MB memory cap, 128 pid cap. |
| Apps cannot read each other's data | one Postgres database and one role per app, `CONNECT` revoked from `public` on every database including the platform's own and the `postgres` maintenance database. |
| Identity cannot be forged | Caddy strips every inbound `Remote-*` header before forward-auth re-injects it, and `request_header` is explicitly ordered before `forward_auth`. The control plane independently verifies the administrator's host cookie, its active parent session, account status and authentication age from the database. |
| The console cannot be driven by a stranger | every `/api/*` route requires the exact deploy token (compared in constant time), a per-app deploy key, or a browser session of an administrator. |
| A deploy key cannot reach beyond its app | a key (`ndd_` + 43 random characters) is stored as a SHA-256 hash and bound to one slug. It opens three routes only: deploying a bundle whose `app.yaml` names that slug, reading that app's logs, and `/api/me`. An unknown or revoked key is refused outright and never falls back to the session check. Deleting an app revokes its keys. |
| A session cannot be replayed on another host | gate keeps a root session on the auth host and gives each other host its own session, through a one-time code (60 s, single use, bound to that host). Its cookies are `__Host-` cookies, so the browser never sends one host's session to another. A cookie an app might copy is useless anywhere else, and Caddy removes it from the requests an app receives anyway, along with any `tinyauth-*` cookie left from an older install and any `ndk_` access key. Signing out ends the root session and every host session made from it. |
| The console needs a recent, administrator sign-in | gate lets a browser reach `deploy.` only for an account flagged as administrator that proved who it is within the last 12 hours; the control plane checks the flag again, from the database, on every request. Personal access keys never open the console. |
| Passwords resist offline guessing and online guessing | scrypt (N=2^15, r=8, p=3, per-password salt); older hashes upgrade on successful login. Ten characters minimum, common passwords refused. Two active password operations and eight queued operations bound memory/CPU; excess requests receive 429. Attempts are reserved before asynchronous work, with per-account/address backoff. An unknown username performs dummy password work too. |
| Sign-in pages cannot be abused from another site | every POST on the auth host must carry the auth host's own Origin; pages refuse framing and load scripts from the auth host only (CSP). Redirects after sign-in only go to the apps domain, on the scheme and port in use. |
| Access rules cannot be dodged with odd paths | protected paths are compared case-insensitively, percent-decoded and with dot segments resolved, which can only make a path look more protected, never less. Apps also check the role in their own code (`requireRole`). |
| Git builds cannot read host files or poison later builds | source, work, temporary files and npm cache live in bounded, private tmpfs mounts; no host bind mount or shared writable cache enters the builder. Builders run as uid 1000, capabilities dropped, read-only root, `no-new-privileges`, 1 CPU, 1.5 GB memory/swap cap, 512 processes and ten minutes. Their internal network exposes only the filtered egress proxy, with no forge or production secrets. |
| Archives cannot plant links or restore dangerous permissions | ZIP/TAR paths and declared/actual sizes are bounded. Extraction creates regular files/directories only, with fixed 0644/0755 permissions. Artifact collection refuses symbolic links, hard links and special files, including linked ancestor directories. |
| Webhooks resist forgery and replay | GitHub raw bodies require HMAC-SHA256; GitLab requires its hook secret, both checked in constant time. Deduplication hashes the authenticated body with the provider identity and survives unsigned delivery-ID changes. Pushes must match the forge's current branch head; previews must match an open, same-project pull request. Fork previews are refused. |
| Database-only theft does not disclose application/forge credentials | environment values, app database passwords, forge tokens and webhook secrets use AES-256-GCM with `NANODEPLOY_SECRET_KEY` held in `.env`. Application ciphertext is bound to its slug and field. Existing plaintext rows migrate at startup. A backup containing both the database and `.env` must still be encrypted. |
| Previews do not inherit production secrets | previews start with their own environment and database. The first upgrade removes inherited values identical to the parent's, except the preview's own `DATABASE_URL`. Add preview-specific credentials explicitly. |
| App-controlled snapshots cannot run restore SQL as postgres | `pg_dump` and `pg_restore` authenticate as the app's own database role. A restore first populates a fresh app-owned database, then swaps names; failure preserves the original. Trusted database-management commands alone use postgres. |
| A repository cannot take over another app | a connection ties a repository branch to one slug; a build whose `app.yaml` names another slug fails. `--pr-` slugs are reserved for previews: an upload cannot claim one. |
| gate cannot read secrets | its database role sees its own schema and six columns of the apps table (slug, name, access, groups, roles, protect): never env values or app database passwords. It has no Docker access. |
| Cookie-authenticated actions require their own origin | console mutations require positive same-origin evidence. Gate also checks unsafe requests to apps when a session supplies authority, including attacks from sibling subdomains. Token callers use explicit bearer authority. Adding passkeys/personal keys requires sign-in within 15 minutes; passkeys require user verification. |
| A broken app cannot take the gateway down | a site file that Caddy refuses is rolled back and the previous config reloaded, so one bad app never freezes route updates for the others. Platform subdomains (`deploy`, `auth`, `id`, `www`) are reserved. |
| Sablier cannot drive Docker arbitrarily or inspect platform secrets | its proxy accepts only managed-app listing/events and named `app-...` inspection/start/stop/wait. It refuses platform names, opaque container IDs, create, exec, archives and deletion. Queries are overwritten to filter managed-app labels and lifecycle events. Caddy, gate and Sablier have no network path to the control plane's privileged socket proxy. |
| Requests and logs are bounded | Caddy caps headers and request time; the control plane bounds bodies and applies per-client request budgets (240 API/minute, 60 hooks/minute). Container memory, pids and logs are bounded. Caddy trusts forwarded IP headers only from configured `TRUSTED_PROXY_CIDRS`. |

Both Docker proxies use the maintained HAProxy 3.2 LTS image with static,
repository-owned ACLs. They start with a read-only root filesystem and no
capabilities; no configuration-generation script needs a writable image layer.

## Known limits, accepted on purpose

These are real. Decide whether they matter for your setup before you deploy.

- **Containers share the host kernel.** This is hardened Docker isolation,
  not a virtual machine per tenant. Keep Docker, the OS/kernel and base images
  patched. Host firewall, SSH, router/tunnel configuration and existing server
  compromise require a separate assessment of the deployed machine.
- **A compromised app can exfiltrate its own secrets over public HTTPS.**
  The proxy prevents private-network access, not arbitrary public API access.
  Internet-facing services remain reachable, including the host's public IP.
  Raw TCP, SMTP, private APIs and destinations outside ports 80/443 require an
  explicitly reviewed alternative; do not restore a shared external bridge.
- **Caddy, Postgres and egress remain shared trusted services.** App bridges
  expose their necessary service ports. Application authorization, SQL roles
  and their own patches still matter. Browser XSS inside an app can act as
  that app's signed-in user.
- **The control plane is root-equivalent.** It can build images and exec into
  containers through its socket proxy. Compromising it compromises the host.
  Every administrator has that power.
- **Gate is trusted to authenticate administrators.** Its session store can
  issue administrator sessions. Full compromise of gate or that store can
  therefore lead to console authority through Caddy even though gate cannot
  directly reach a Docker proxy. Independent cookie checks reject forged
  headers; they do not make a compromised identity service trustworthy.
- **Availability is not guaranteed against a determined denial of service.**
  Rate limits are local to one process. App data volumes have no disk quota,
  and Postgres resources remain shared. Use host storage monitoring, connection
  budgets and an outer rate limiter suited to the actual deployment. Configure
  trusted proxy addresses precisely so client budgets use real visitor IPs.
- **A build runs code from the repository and its dependencies.** The sandbox
  limits what it can reach, not what it can do inside: a malicious dependency
  can still fill its 1.5 GB, use the CPU for ten minutes, talk to the internet,
  and ship a backend that does whatever it wants once deployed (an app is
  arbitrary code, as always). Connect repositories you trust.
- **Rate limits live in memory.** Restarting gate resets the counters.
- **No email.** Nanodeploy sends no mail: an invitation or a forgotten password
  is a link an administrator hands over. A second factor (TOTP) is not there yet;
  a passkey is the strong option.
- **The waiting page is served with a 200.** When a sleeping app is woken, the
  first request gets Sablier's HTML page instead of the app's answer. Clients
  must retry; the template's `src/client.ts` does. This is a correctness trap
  more than a security one, but an API consumer that ignores it will misbehave.
- **The access log holds addresses for a few days.** Caddy writes every request
  of every app to one JSON log (three files of 20 MB at most, rotated), with the
  client address and user agent, cookies and authorization headers masked. The
  control plane reads it and stores only aggregates and a daily-salted visitor
  hash. The salt is replaced every midnight. For apps that are not public,
  administrators see which accounts used them on which days; the account page
  says so.
- **Database snapshots sit on the server, in clear.** Before each migration the
  app's database is dumped to `APPS_DIR/.snapshots/<slug>/` (directory 0700,
  files 0600, the last three kept). Caddy mounts `APPS_DIR` read-only and masks
  `.snapshots`, `.builds` and `.staging` with empty read-only mounts. Include the directory in your encrypted
  backups, or exclude it on purpose.
- **No automatic backups.** A single shared Postgres is a single point of loss
  for every app. See the README.

## Rotating secrets

- `DEPLOY_TOKEN`: change it in `.env`, then `docker compose up -d control-plane`.
  Caddy does not receive this secret; the control plane checks it independently.
  Prefer deploy keys for anything that leaves the server.
- A deploy key: revoke it in the app's panel and create a new one. Revoking
  takes effect on the next request.
- `POSTGRES_PASSWORD`: change it in Postgres first (`ALTER ROLE postgres
  PASSWORD ...`), then in `.env`, then restart the control plane.
- `NANODEPLOY_SECRET_KEY`: preserve it and back it up separately. Replacing it
  directly makes all stored app environments, database passwords and forge
  credentials unreadable. Rotation requires a maintenance migration that
  decrypts with the old key and re-encrypts with the new one before restarting;
  there is no automatic rotation command. Losing the key requires restoring a
  matching database/key backup or resetting every affected credential.
- `GATE_DB_PASSWORD`: change it in `.env`, then `docker compose up -d
  control-plane gate`. The control plane sets it on the database role at start.
- `POCKETID_ENCRYPTION_KEY`: only for an upgrade still importing from Pocket ID;
  do not rotate casually, Pocket ID encrypts stored
  data with it.
- An app's database password is regenerated only if you delete its row; there is
  no rotation command yet.
