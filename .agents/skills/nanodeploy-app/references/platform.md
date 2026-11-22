# How Nanodeploy works

## Contents
- The pieces
- One request, step by step
- Who is calling: identity headers
- Sleep and wake-up
- The container your server code runs in
- Network: what the app can reach
- The database and migrations
- What a deploy does
- Access, roles and secrets: who decides what
- The dashboard, screen by screen
- What the platform will not do

## The pieces

| Piece | Job |
|---|---|
| Your HTTPS proxy or tunnel | Ends TLS, forwards `*.<domain>` to Caddy. Set up by whoever runs the server. |
| Caddy (+ Sablier plugin) | Routes each host, serves static files, holds requests while an app wakes up. |
| Sablier | Starts a stopped app container on demand, stops it after `idle.timeout`. |
| gate | Accounts, passwords, passkeys, groups, app roles; decides who may open what; injects identity headers. Lives at `auth.<domain>`. |
| control plane | The dashboard at `deploy.<domain>`, the deploy API, Git builds, releases. |
| Postgres 16 | One shared server, one database and one role per app. |
| egress proxy | The only way out to the internet for apps and builds. |
| `app-<slug>` | Your backend container: Node 24 running your bundled `server.js`. |

## One request, step by step

A browser opens `https://notes.apps.example.com/...`:

1. The proxy or tunnel ends HTTPS and passes the request to Caddy.
2. Caddy deletes any `Remote-*` header the client sent. Identity can only come
   from gate.
3. Paths under `/_nd/` are answered by the platform, never by the app:
   `/_nd/me` (who is signed in), `/_nd/login?rd=<path>`, `/_nd/logout`, and
   `/_nd/e` (page-view beacon, an empty 204).
4. gate checks access:
   - `private` app: only signed-in accounts of the server; `groups` app: only
     members of the listed groups. Anyone else is sent to the sign-in page
     (browser) or gets `401 {"error":"sign in first"}` (API call).
   - `public` app: anyone. A signed-in visitor still gets identity headers on
     `/api/*`; an anonymous one gets none.
   - `protect` rules (public apps with a back office): the listed paths need
     the role, checked before the request reaches the app.
5. `/api/*` goes to the backend. The platform session cookie and the
   `Authorization` header of a personal key are hidden from the app. If the
   container is stopped, Sablier answers with an **HTML waiting page** (status
   200 or 503) and starts it. `src/client.ts` sees that page and retries.
6. Every other path is a file from the live version's `dist/`. A path with no
   file gets `dist/index.html`, so client-side routes work.

Two consequences: a backend route outside `/api/` is never reached, and
loading the page does not wake the backend; the first `/api` call does.

## Who is calling: identity headers

On requests with a signed-in user, gate adds:

| Header | Content |
|---|---|
| `Remote-Sub` | Stable account id. **Store it as `ownerId`.** Never use the email as a key. |
| `Remote-User` | Username |
| `Remote-Name` | Display name (UTF-8, any script) |
| `Remote-Email` | Email |
| `Remote-Groups` | Comma-separated groups |
| `Remote-Roles` | Comma-separated roles this person holds **in this app** (administrators hold every role) |

Read them only through `server/auth.ts` (`tryGetUser`, `getUser`, `hasRole`,
`requireRole`): header values arrive as Latin-1 and the helper decodes UTF-8.
Never accept a user id from a body or query string.

Scripts can call an app's API with a **personal access key**:
`Authorization: Bearer ndk_...`, created by each person on their account page
at `auth.<domain>`. gate turns it into the same headers, so an app gets an API
for scripts without writing any auth code.

## Sleep and wake-up

- After `idle.timeout` (default `10m`) without an `/api` request, the
  container is stopped: 0 MB, 0 CPU.
- The next `/api` request starts it. The first answer is the waiting page;
  the real answer follows in about a second.
- `idle.warm: true`, or **Always active** in the app's Settings, keeps it
  running permanently for about 40 MB. The dashboard setting wins over
  `app.yaml`. Only for apps that truly must run continuously.
- A server reboot is the same as a sleep. The process can stop between any two
  lines of your code: write to the database before answering, never after.

## The container your server code runs in

| Property | Value | Consequence |
|---|---|---|
| Image | `node:24-bookworm-slim` + your **entry file only** (`server.js`) | No `node_modules`: bundle everything with esbuild. No native addons. No files next to the code. |
| `NODE_ENV` | `production` | |
| User | uid 1000, all capabilities dropped | |
| Filesystem | read-only | Writing anywhere else throws. |
| `/data` | persistent volume, one per app | Uploaded files. Kept across deploys and in backups. |
| `/tmp` | 16 MB, wiped at every start, no executables | Scratch space only. |
| Memory | 256 MB | Never load a big file in memory. |
| CPU / processes | 1 CPU, 128 processes | No worker pools. |
| Environment | your `env` values, `DATABASE_URL` (if `database.enabled`), `PORT`, proxy variables | A declared variable with no value yet is simply absent. |
| Ports | none published | Only Caddy reaches it. |

There is **no health check**: a deploy never starts your server. A server that
crashes at boot deploys "successfully" and fails on the first visit. So the
server must start with no env value set, connect to Postgres lazily (the
template's `postgres()` client does), and do no work at import time.

## Network: what the app can reach

The container sits on its own private network. It reaches Postgres, Caddy and
the egress proxy, nothing else: not other apps, not the LAN, not the host.

To the internet, only through the proxy (`HTTP_PROXY`, `HTTPS_PROXY` and
`NODE_USE_ENV_PROXY=1` are set), only **public addresses on ports 80 and
443**. Node 24's `fetch` uses the proxy automatically; another HTTP library
must support proxy variables. Consequences:

- No SMTP (ports 25, 465, 587): send email through an HTTPS email API.
- No home devices, private IPs, databases elsewhere, or raw TCP.
- An upstream call that takes more than 30 seconds is cut.
- Every outbound call sends data off the machine: tell the user, keep the API
  key on the server.

## The database and migrations

- One database and one role per app on the shared Postgres 16. The app gets
  `DATABASE_URL`. Keep the pool at `max: 3`: every connection is a process on
  a small server shared by every app.
- `migrations/` holds plain `.sql` files. At each deploy the control plane
  runs the files it has not run yet, **in file-name order**, each in its own
  transaction, and records each **file name** in a `_migrations` table. The
  app never migrates at boot.
- Renaming an applied file makes it run again. Editing one changes nothing on
  databases that already ran it. So: never edit or rename a deployed migration.
- Before applying migrations to an existing database, the platform dumps it.
  If a migration fails, the database is restored and the live version is left
  as it was.
- Each app has its own database, so two apps may use the same table, index
  and constraint names. Inside one app, index names are shared by all its
  tables: prefix them with the table name (`items_owner_idx`).
- Deleting an app deletes everything: its database and role, its `/data`
  files, its images and versions. Only the server backups keep a copy. A new
  app with the same slug starts empty. Pull-request previews get their own
  empty database.

## What a deploy does

Whatever the source (dropped zip, `npm run deploy`, Git build), the same
pipeline runs:

1. **Validate** the bundle: exactly one `app.yaml` at the top level,
   `dist/index.html` if `frontend` is true, the entry file if there is a
   backend, safe paths, size limits.
2. **Stage** it next to the live version as version *n*.
3. **Build** a tiny image holding only the entry file.
4. **Snapshot and migrate** the database if there are new `.sql` files.
5. **Create the container**, then stop it again if the app sleeps.
6. **Switch** the live version and the route in one step.

Any failure leaves the live version untouched. The response log says which
env variables are still unset and warns if the app's hostname does not
resolve.

Versions: the last 10 keep their files, the last 3 their image (rollback is a
container swap) and their database snapshot. Going back to an older version
offers two choices: keep the data (the old code meets a newer schema) or
restore the database snapshot (everything written since is lost).

## Access, roles and secrets: who decides what

| Setting | Set in | When it applies |
|---|---|---|
| `access`, `groups` | `app.yaml` | **First deploy only.** Afterwards only the dashboard (Access tab) changes it. |
| `roles`, `protect` | `app.yaml` | Every deploy. |
| Who holds a role | Dashboard, Access tab, Roles | Immediately. Administrators hold every role. |
| `env` names | `app.yaml` | Every deploy. |
| `env` values | Dashboard, Settings tab | Write-only; the backend restarts with the new value. |
| Always active | Dashboard, Settings tab | Overrides `idle.warm`; survives deploys and rollbacks. |

## The dashboard, screen by screen

The console lives at `https://deploy.<domain>` and only administrators reach it.

- **New application**, with three methods:
  - **ZIP archive**: drop a `-deploy.zip`. The dashboard shows what will
    change, then publishes.
  - **Git repository**: connect a repository and branch (see deploy-git.md).
  - **Terminal & agents**: create a deploy key for a new slug.
- **An app's panel**:
  - **Overview**: status, current version, memory, recent activity.
  - **Deployments**: version history, **Deploy a version** (drop a new zip),
    going back to an older version.
  - **Access**: private, groups or public, plus **Roles** (who holds each
    role) when the app declares roles.
  - **Settings**: Always active, environment variable values, deploy keys,
    deleting the app.
  - **Logs**: the backend's recent output.
- **Git deployments**: forges, connected repositories, builds and their logs.
- **People & access**: accounts, invitations, groups, administrators.
- **Analytics**: visits, wake-ups, memory, errors. Counted from the gateway's
  logs; apps add no script.

A **deploy key** (`ndd_...`) is bound to one slug. It can deploy that app,
read its logs, list its versions and go back to one. Nothing else: no env
values, no access changes, no other app. The server's own `DEPLOY_TOKEN` can
do everything; never ask for it.

## What the platform will not do

- Run anything while the app sleeps (cron, queues, background jobs).
- Keep a websocket open across a sleep.
- Provide Redis, MongoDB, SQLite files, object storage or email sending.
- Render pages on the server outside `/api/*` (no SSR).
- Let an app reach private networks or other apps.
- Back up anything automatically: the server owner runs `scripts/backup.sh`.
