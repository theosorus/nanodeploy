# Troubleshooting

## Contents
- How to use this file
- npm run check, doctor, zip
- Uploading (npm run deploy, dashboard)
- Git builds
- The app once live
- Access and sign-in

## How to use this file

Search for the exact message you got (or its first words) on this page. Each
row gives the cause and the fix. If nothing matches, read the full output
again: the platform's messages say what to change.

## npm run check, doctor, zip

| Message | Cause | Fix |
|---|---|---|
| `slug is still the template's "mon-app"` / `name is still the template's "Mon app"` | Template values left in app.yaml | Set the app's own `name` and `slug`. |
| `slug "..." is invalid` | Uppercase, `_`, `--`, ends with `-`, too long | 2 to 31 characters: lowercase letters, digits, single dashes. |
| `app.yaml line N: ...` | Outside the simple YAML subset | Follow "Writing rules" in [manifest.md](manifest.md). |
| `dist/index.html is missing` | Not built | `npm run build` (or `npm run zip`, which builds). |
| `dist/index.html is the unbuilt source page` | Files copied into `dist/` by hand | Delete `dist/`, run `npm run build`. |
| `server.js is missing` | Not built, or `backend` declared for a static site | Build, or remove `backend` from app.yaml. |
| `server.js imports X at runtime` | Package marked external or not bundled | Use the template's build script (esbuild `--bundle`). |
| `migrations/ has no .sql file` | Schema written, migration not generated | `npm run db:generate`. |
| `dependency X: native addon` | bcrypt, sharp, sqlite, prisma... | Remove it; see the reason printed. |
| `periodic timer` | `setInterval` or cron | Do the work on request (see build-the-app.md). |
| `process.env.X is never set` | Variable used, not declared | Add `X` to `env` in app.yaml. |
| `bare fetch to /api` | `fetch("/api/...")` in the frontend | `api()` from `src/client.ts`. |
| `crashed at start` | The server throws at import (often a missing env value or an external call at load) | Move that code inside the route; the printed error says which. |
| `loads from fonts.googleapis.com` (or another CDN) | Third-party file | Self-host it (see art-direction.md). |
| `Postgres pool without max: 3` | Pool created elsewhere without a limit | Use `server/db.ts`. |
| TypeScript errors from `npm run typecheck` | Type mistakes | Fix them; never disable `strict`. |
| `npm ci` says the lockfile is out of sync | `package.json` edited by hand | `npm install`, commit `package-lock.json`. |
| `drizzle-kit generate` waits for an answer | It suspects a rename | Stop it; avoid renames (see change-an-app.md). |
| `zip failed` with a stack trace | Unexpected problem in the script | Read the first line; report it to the user with the output. |

## Uploading (npm run deploy, dashboard)

| Message | Cause | Fix |
|---|---|---|
| `set NANODEPLOY_URL and NANODEPLOY_TOKEN` | Variables not set in this shell | Set both (deploy-zip.md, mode B), or hand over the zip instead. |
| `bundle must contain exactly one top-level app.yaml` | Folder zipped instead of its content, or the source zip dropped | Use `npm run zip`; drop the `-deploy.zip`. |
| `unsafe archive path` | Backslashes (PowerShell `Compress-Archive`), absolute path or `..` | Use `npm run zip`. |
| `bundle is missing dist/index.html` / `bundle is missing server.js` | Archive made before building, or the wrong files picked | `npm run zip`. |
| `symbolic links and special files are forbidden in bundles` | A link in `dist/` or `migrations/` | Copy real files. |
| `bundle too large` / `payload too large` | Over 100 MB | Remove big media from `dist/`; store uploads in `/data` instead. |
| `this deploy key is for X, the bundle's app.yaml says Y` (403) | Key and slug disagree | Use the key made for this slug, or fix the slug. |
| `this deploy key only deploys X` (403) | The key was used on another route or app | A key deploys, reads logs and versions of one app only. |
| `unknown or revoked deploy key` (401) | Mistyped, revoked, or the app was deleted | Ask the user for a new key. |
| `another bundle is being processed; retry shortly` (429) | Another upload is running | `npm run deploy` retries by itself; in the dashboard, wait and drop again. |
| `HTTP 302/401/403: <!doctype html...` | `NANODEPLOY_URL` points at an app, or an extra access layer guards the console | Use `https://deploy.<domain>`; the console API must be reachable without a browser sign-in. |
| `fetch failed` | Wrong address, server down, no network from your sandbox | Check the URL; on claude.ai, hand over the zip instead. |
| `"--pr-" slugs are made by the platform` | Slug ends with `--pr-<n>` | Pick another slug. |
| `env X is managed by the platform` | `DATABASE_URL`, `PORT` or a proxy variable in `env` | Remove it from `env`. |
| `protect /x needs role "y", which is not in roles` | Role missing | Add it to `roles`. |
| `access: groups requires a non-empty groups list` | `groups: []` with `access: groups` | List the groups. |
| `migration failed (...); the database was restored from the snapshot taken just before` | The SQL failed (often `NOT NULL` without a default, or a duplicate) | Fix the newest migration (it was not recorded), deploy again. |
| `migration failed (<file>: relation "x" already exists. The database already has what this file creates...)` | A deployed migration was renamed, deleted or regenerated (drizzle-kit picks a new random file name), so the platform sees a new file that creates existing tables | Restore the deployed migration files unchanged from Git or the last source zip, then run `npm run db:generate` for the changes only. Never regenerate migrations of a live app. |
| `this bundle is for "x", not "y"` | Dropped on another app's panel | Drop it on the right app. |
| `env X is declared but not set yet` (log line, not an error) | No value typed yet | The user types it in Settings. |
| `WARNING: <host> does not resolve` | No wildcard DNS for the domain | Server owner adds `*.<domain>` to DNS or the tunnel. |

## Git builds

| Status or log | Cause | Fix |
|---|---|---|
| `no app.yaml in <dir>` | Wrong "Project directory", or app.yaml not committed | Commit it, or reconnect with the right folder. |
| `app.yaml says "x", this repository deploys "y"` | Slug changed | Put the slug back. |
| `the build exited with code N` | `npm ci` or `npm run build` failed | Reproduce with the clean-clone check (deploy-git.md); fix; push. |
| `the build took more than 10 minutes` | Very slow install or build | Trim dependencies and build steps; the limit is fixed. |
| `waiting for memory` in the log | The server is short of RAM | Wait; it retries for about five minutes. |
| `the app X is already deployed from a repository` | The slug is connected to another repository | Disconnect the old one first, or use another slug. |
| `this repository is not available to the connection` | The GitHub App was not given this repository | **Choose repositories** in Git deployments. |
| Status stays `pending` | Queue busy, or the webhook never arrived | Check Git deployments; **Build now**; make sure `/hooks/` is reachable. |
| `interrupted: the control plane restarted during this build` | Server restarted | Push again or **Build now**. |

## The app once live

| Symptom | Cause | Fix |
|---|---|---|
| First API call shows an HTML error or `Unexpected token '<'` | Bare `fetch` received the waiting page | `api()` from `src/client.ts`. |
| `the backend did not wake up in time` | The server crashed at start or is slow to boot | Read the logs (`/api/apps/<slug>/logs` or the Logs tab); run doctor's boot check. |
| 502 on `/api` | The server crashed or listens on another port | Logs; listen on `process.env.PORT`. |
| 404 on an `/api` route that exists | Route registered outside `/api/`, or no `backend` in app.yaml | Fix the path; keep the `backend` map. |
| `relation "x" does not exist` | Migration not generated or not shipped | `npm run db:generate`, redeploy with `migrations/`. |
| Data vanished after a while | Kept in memory or in `/tmp` | Postgres or `/data`. |
| Outbound call fails or `destination refused` | Private address, non-80/443 port, or a client ignoring the proxy | Public HTTPS only; use Node's `fetch`. |
| Killed, logs show out of memory | Over 256 MB | Stream files, bound queries, never load a whole table or file in memory. |
| Everyone sees everyone's rows | A query without the `ownerId` filter | Filter every read and write on `ownerId`. |
| Page refresh on a deep link shows the app's home | Expected: unknown paths serve `index.html` | Route on the client (hash or history). |

## Access and sign-in

| Symptom | Cause | Fix |
|---|---|---|
| `401 {"error":"sign in first"}` from your API | No identity: anonymous visitor on a public app, or a test outside the gateway | Answer 401 in the app as designed; show a sign-in link (`loginUrl()`). |
| `this needs the <role> role` (403) | A `protect` rule | The user grants the role in the Access tab. |
| `this app is reserved to some groups` | `access: groups` | Add the person to one of the groups. |
| Changed `access` in app.yaml, nothing happened | Access only applies at creation | The Access tab. |
| Moderation buttons missing for an administrator | The frontend checks roles from `/_nd/me`; administrators hold every role | Call `getMe()` after load; check `hasRole(me, role)`. |
