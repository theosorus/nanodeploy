# Nanodeploy app template

An MIT-licensed React/TypeScript frontend, Hono backend and PostgreSQL notes app.
Authentication comes from the Nanodeploy gateway. There is no maintainer account
or server address in the template.

## First deployment

You need a Nanodeploy instance, Node.js 24 and npm. In the Nanodeploy
repository, `docs/INSTALL.md` and `docs/INSTALL.fr.md` explain server setup;
`./install.sh --local` runs a local trial.

```bash
cp -R templates/app-template ../my-app
cd ../my-app
npm ci
```

Set `name` and `slug` in `app.yaml`, keeping `access: private` initially. Generate
the initial notes-table migration:

```bash
npm run db:generate
```

Create an app deploy key for that exact slug in the console (**New application
→ Terminal & agents**). Set these values in your own shell:

```bash
export NANODEPLOY_URL=https://deploy.apps.example.com
export NANODEPLOY_TOKEN=ndd_REPLACE_WITH_YOUR_APP_DEPLOY_KEY
npm run deploy -- -m "First deployment"
```

Use your own domain. For a local instance, use
`NANODEPLOY_URL=http://deploy.apps.localhost:8080`. Open the URL printed by the
deployment and sign in. Notes belong to the signed-in user and survive sleep.

No terminal access to the server, or no deploy key? Make the archives instead:

```bash
npm run zip
```

It checks the code, builds, and writes two files next to `app.yaml`:

- `<slug>-deploy.zip`: `app.yaml`, `dist/`, `server.js` and `migrations/` at the
  top level. Drop it in the console under **New application → ZIP archive**, or
  on an existing app's panel to publish a new version.
- `<slug>-source.zip`: the project inside a `<slug>/` folder, without
  `node_modules`, build output or `.env`. Keep it to change the app later or to
  push it to Git. The console refuses it on purpose.

`npm run zip -- --out-dir <dir>` writes them elsewhere. The archives are made in
Node itself, so no `zip` program is needed on Windows. Never zip the folder by
hand: an archive whose `app.yaml` sits inside a folder, or whose paths use `\`,
is refused.

Do not copy the platform's root `DEPLOY_TOKEN` into your app or CI. An app deploy
key is limited to its own slug. Declare external API secret **names** in the
manifest; set their **values** in the console, never in frontend source or Git.

## Develop and change the schema

The frontend lives in `src/`, the API in `server/index.ts` and the database
schema in `server/schema.ts`. Every API path starts with `/api/`. Use
`src/client.ts` so calls retry the HTML waiting page returned while an app wakes.
Use `server/auth.ts` for gateway identity, and keep the owner filter on every
user-owned query.

`npm run dev` starts Vite and the API watcher. The backend needs a disposable
PostgreSQL `DATABASE_URL` exported in your shell; Vite proxies `/api` to port
3000. Gateway identity is only supplied when going through Nanodeploy, so local
API requests without it return 401. For a complete signed-in development loop,
deploy changes to a local Nanodeploy instance. Do not add a production auth
bypass to make direct Vite requests work.

After editing the schema, run `npm run db:generate`, review the SQL and keep
`migrations/` in Git. The platform applies SQL migrations at deployment time.
Never change a migration already deployed. Prefer additive schema changes so
an earlier release can still run against the current database.

## Checks and Git deployments

```bash
npm run check    # typecheck, tests, build, then npm run doctor
```

`npm run doctor` reads the code for what breaks on the platform: timers,
websockets, a bare `fetch` to `/api`, an unbundled or native dependency, an
environment variable missing from `app.yaml`, a font from a CDN. An `ERROR`
must be fixed; a `WARN` deserves a look.

The build produces `dist/` and a bundled `server.js`. `npm run deploy` and
`npm run zip` archive those together with `app.yaml` and `migrations/`. Commit
the source, lockfile and migrations; generated builds, `.env` and ZIP files are
ignored.

For a repository connected in Nanodeploy's Git deployments tab, run
`npm run check`, then commit and push instead of calling `npm run deploy`. The
platform runs `npm ci` and `npm run build` on the connected branch and can
create private pull-request previews with separate databases and separate
environment variables.

Apps may stop at any time. Store state in Postgres or `/data`, keep the pool at
three connections, and avoid in-memory sessions or background timers. The
platform runs Node 24 and configures an HTTP/S egress proxy; custom HTTP clients
must support its proxy environment variables.

When publishing a derived app, keep the included MIT `LICENSE` with the
template code and preserve third-party notices.
