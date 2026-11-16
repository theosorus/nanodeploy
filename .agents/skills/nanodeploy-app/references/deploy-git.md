# Deploying from a Git repository

## Contents
- How Git deployments work
- What the repository must contain
- New app in a new repository
- Connecting the repository (the user does it)
- Everyday changes: branch, pull request, preview
- Reading the build result
- Pull-request previews
- The build: section
- Adapt an existing project
- Git-specific mistakes

## How Git deployments work

A repository branch is connected to one app in the console (**Git
deployments**). Then, on every push to that branch, the server:

1. downloads the commit's archive (the forge token never enters the build);
2. reads `app.yaml` in the connected folder and checks its `slug` is the
   connected app;
3. runs, in a throwaway `node:24-bookworm-slim` container as uid 1000, with
   1.5 GB of memory, a 10-minute limit and no app secrets:
   - `npm ci --no-audit --no-fund` if `package-lock.json` exists, otherwise
     `npm install --no-audit --no-fund`;
   - `npm run build`;
4. takes `dist/`, the backend entry (`server.js`) and `migrations/` from the
   result: the same files `npm run zip` would pack;
5. sends them through the normal release pipeline (snapshot, migrations,
   container, switch);
6. posts a commit status named `nanodeploy` on the forge: green with the app
   link, or red with the error.

One build runs at a time on the whole server. A newer push to the same branch
skips older queued builds. A build waits when the server is short of memory.

Builds reach public HTTP/S through the platform proxy (the npm registry
works), nothing private, and **get no environment values**: a build step that
needs a secret or calls your own services fails.

## What the repository must contain

```
- [ ] app.yaml at the root, or in the folder chosen as "Project directory"
- [ ] package.json whose "build" script leaves dist/index.html and server.js
- [ ] package-lock.json, committed and in sync with package.json
- [ ] migrations/*.sql (and migrations/meta/), committed: the server never generates them
- [ ] .gitignore with node_modules/, dist/, server.js, *.zip, .env
- [ ] no secret anywhere in the history: names in app.yaml env, values in the dashboard
- [ ] npm run check passes on a clean clone
```

The template already has the right `package.json`, `.gitignore` and scripts.

A repository with **no `package.json`** is not built: its files are deployed
as they are, so a static site must commit `dist/index.html` itself.

## New app in a new repository

1. Build the app with the normal workflow (SKILL.md, section 3) in its own
   folder, up to `npm run check` with 0 errors.
2. Prove the server's build will pass, from a clean copy:

```bash
git init -b main
git add -A
git commit -m "First version of <name>"
git clone . ../check-build
cd ../check-build
npm ci
npm run build
node -e "for (const f of ['dist/index.html', 'server.js']) if (!require('fs').existsSync(f)) { console.error('missing ' + f); process.exit(1) }"
cd ..
```

   Then delete `check-build` (`rm -rf check-build`, or
   `Remove-Item -Recurse -Force check-build` in PowerShell).
   If `npm ci` fails with "package.json and package-lock.json are in sync",
   run `npm install` in the app folder, commit the lockfile, and try again.

3. Create the remote repository, **private** unless the user says otherwise:

```bash
gh repo create <owner>/<repo> --private --source . --push        # GitHub
glab repo create <group>/<repo> --private && git push -u origin main   # GitLab
```

   If `gh` or `glab` is missing or not signed in, ask the user to create an
   empty repository and give you its URL, then
   `git remote add origin <url> && git push -u origin main`.

4. Ask the user to connect it (next section), giving them the exact values.
5. Wait for the first build's status (see "Reading the build result").

## Connecting the repository (the user does it)

An agent cannot do this step: it needs an administrator session in the
console. Give the user these steps with the values filled in.

**Once per server, if no forge is connected yet** (console → **Git
deployments**):

- GitHub: **Connect GitHub**, confirm the GitHub App creation on GitHub.
- GitLab: **Connect a GitLab project** with `group/project` and a project
  access token (in GitLab: the project → Settings → Access tokens, role
  Maintainer, scopes `api` and `read_repository`). Each GitLab project is
  connected this way, one at a time.

**For a new GitHub repository**: the GitHub App only sees repositories it was
given. In **Git deployments**, click **Choose repositories** and add the new
one. Otherwise it is missing from the list, or the connection fails with
"this repository is not available to the connection".

**Then, under Deploy a repository**:

| Field | Value |
|---|---|
| Forge | the GitHub or GitLab connection |
| Repository | `<owner>/<repo>` |
| Branch | `main` (the branch that deploys) |
| Project directory | `.`, or the folder holding `app.yaml` in a monorepo |
| Preview each pull request | on, unless the user says otherwise |

Click **Deploy from this repository**. The server reads `app.yaml` on that
branch, ties the repository to that slug, and starts the first build at once.

Webhooks arrive at `https://deploy.<domain>/hooks/`. If the console sits behind
an extra access layer (Cloudflare Access, a VPN), that path must stay open;
otherwise pushes do nothing and only **Build now** works.

## Everyday changes: branch, pull request, preview

Default flow, unless the user asks to push to `main` directly:

```bash
git switch -c <short-topic>
# change the code, then:
npm run check                       # 0 errors before every push
git add -A && git commit -m "<what changed>"
git push -u origin <short-topic>
gh pr create --fill                 # GitHub
glab mr create --fill --yes         # GitLab
```

The pull request gets a preview at `https://<slug>--pr-<n>.<domain>` (see
below). Give the user that URL once the status is green. Push more commits to
the same branch to update the preview. The user merges; the merge push
deploys production.

Never push generated files (`dist/`, `server.js`, zips) and never rewrite
history on the connected branch.

## Reading the build result

The commit status is named `nanodeploy`: `pending` (queued or building), then
`success` (its link is the app) or `failure` (its description is the error, at
most 140 characters).

```bash
gh pr checks                                        # GitHub: the current branch's pull request
gh api repos/<owner>/<repo>/commits/<sha>/status    # GitHub: any commit
glab api "projects/<group>%2F<repo>/repository/commits/<sha>/statuses"   # GitLab: any commit
```

(`glab ci status` shows GitLab pipelines, not this status.)

A build takes from 30 seconds to a few minutes; check every 30 seconds, at
most 15 minutes. If it stays `pending`, the server is busy or the webhook did
not arrive: ask the user to check **Git deployments** (and **Build now**).

When it fails:

1. Read the status description.
2. The full build log is in the console: **Git deployments**, the build,
   **Log**. A deploy key cannot read it; ask the user to paste it.
3. Reproduce locally with the clean-clone check above. Fix, commit, push.

Common failures: `npm ci` refusing a stale lockfile; a dependency that needs a
secret or a private registry at build time; a TypeScript error the template's
build does not hide; `app.yaml says "x", this repository deploys "y"` (slug
changed); `the build took more than 10 minutes`.

## Pull-request previews

- Address: `https://<slug>--pr-<n>.<domain>`, for accounts of the server only,
  whatever the production app's access.
- Its own **empty database**: every migration runs from scratch. Test data
  must be created in the preview.
- **No environment values** by default: production secrets are not copied.
  The user sets preview values in the preview app's **Settings**.
- Updated by each push to the pull request's branch; removed when the pull
  request is closed or after 14 days without a build.
- Pull requests from forks are never built.

## The build: section

Only Git deployments read it (a zip arrives built):

```yaml
build:
  image: node:24-bookworm-slim   # default
  install: npm ci                # default: npm ci with a lockfile, npm install without; "" = skip
  command: npm run build         # must leave dist/ and the backend entry
```

Change it only when the template's defaults do not fit, e.g. a build script
with another name. Stay on npm: other package managers are untested here, and
the build container's filesystem is read-only outside its work folders.

## Adapt an existing project

Goal: make an existing repository, folder or zip run on Nanodeploy with the
fewest changes. The platform requires a **contract**, not the template's stack.

**The contract (non-negotiable)**

| Requirement | Why |
|---|---|
| `app.yaml` at the app's root with a valid slug | The platform reads nothing else |
| The frontend builds to static files with `dist/index.html` | Caddy serves files; no page server runs |
| The backend is one bundled file listening on `process.env.PORT`, all routes under `/api/` | The image holds that file only; only `/api/*` reaches it |
| No native modules, no files read next to the code | No `node_modules` in the image |
| Data in Postgres via `DATABASE_URL`, schema changes as `.sql` files in `migrations/` | The only database; migrations run at deploy |
| No in-memory state, timers or websockets; boots with no env value | The app sleeps and has no health check |
| No login code; identity from `Remote-*` headers | The gateway signs people in |
| Outbound calls only to public HTTP/S | The egress proxy blocks the rest |

**Procedure**

1. Read the project: framework, build command, server entry, database,
   auth, environment variables, background jobs. List each contract item it
   breaks, and show the list to the user before changing anything.
2. Add `app.yaml` (see [manifest.md](manifest.md)), copy
   `SKILL_DIR/assets/app-template/scripts/` (zip, doctor, deploy) into the
   project and add the template's `doctor`, `check`, `zip` and `deploy`
   entries to `package.json` `scripts`.
3. Make `npm run build` produce `dist/` and a bundled `server.js`, e.g.
   `vite build && esbuild server/index.ts --bundle --platform=node --target=node24 --format=esm --outfile=server.js`
   (copy the template's full build line, banner included).
4. Fix each broken item with the smallest change:

| Found | Change to |
|---|---|
| Next.js / Nuxt with server rendering | Static export (`output: "export"`) if the pages need no server; otherwise move data loading to `/api` routes and render on the client |
| Express server | Keep it if it is pure JavaScript: bundle it with esbuild, mount routes under `/api`, listen on `process.env.PORT`. New code uses Hono |
| Prisma | Drizzle, with the existing tables written in `server/schema.ts` |
| SQLite file | Postgres; export the data and import it once the app exists |
| Login, sessions, JWT, users table | Remove; read `tryGetUser(c)` (copy `server/auth.ts`); keep app data keyed by `ownerId` = `Remote-Sub` |
| `.env` file | Names in `env` in app.yaml, values typed in the dashboard |
| Cron, queue, `setInterval` | Work done on request, or `idle.warm: true` with the user's agreement |
| Websockets | Polling or SSE |
| Bare `fetch` to the API in the frontend | Copy `src/client.ts`, call `api()` |
| Files written next to the code | `/data`, served by an `/api` route |
| Monorepo | Leave it; set "Project directory" to the app's folder when connecting |

5. Run `npm run check` until 0 errors, then deliver by ZIP or Git.
6. Say what you could not keep (for example user accounts that existed in the
   old app's own login) and how existing data moves over.

## Git-specific mistakes

| Mistake | Effect | Fix |
|---|---|---|
| `package.json` edited by hand, lockfile not updated | `npm ci` fails on the server | `npm install`, commit the lockfile |
| `migrations/` not committed | Tables missing, first API call fails | Commit `migrations/` including `meta/` |
| `slug` changed in a connected repository | Build fails on purpose | Put the slug back; a new slug is a new app |
| A secret committed | Leaked to everyone with repository access, forever in history | Revoke the secret, then declare its name in `env` |
| Build needs a variable (`VITE_API_KEY`) | Empty at build time; public anyway | Read configuration through an `/api` route |
| New GitHub repository not added to the GitHub App | Missing from the list, or "not available to the connection" | **Choose repositories** in Git deployments |
| Also deploying the same app with a zip | The next push replaces it | One mode per app |
