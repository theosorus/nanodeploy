# Changing an app that is already live

## Contents
- Before touching anything
- What a new version replaces, and what it keeps
- Code-only changes
- Schema changes: expand, then contract
- Changing app.yaml
- Delivering the change
- Going back

## Before touching anything

1. **Get the current source.** One of: the Git repository, the last
   `<slug>-source.zip`, or the folder the user points to. Never rebuild an app
   from memory or from its deployed files: `dist/` and `server.js` are build
   output, not source. If no source exists, say so and stop.
2. **Read** `app.yaml`, `src/theme.css`, `server/schema.ts` and the list of
   files in `migrations/`. The slug, the look and the applied migrations are
   fixed facts you work around.
3. If the project lacks `scripts/zip.mjs` or `scripts/doctor.mjs` (made with
   an older template), copy them from `SKILL_DIR/assets/app-template/scripts/`
   and add the template's `doctor`, `check` and `zip` entries to
   `package.json` `scripts`.
4. Run `npm ci` then `npm run check` **before** changing anything, so you know
   which errors were already there.

## What a new version replaces, and what it keeps

| Replaced by each deploy | Kept |
|---|---|
| Frontend files, server image, container | The database and its rows |
| `roles`, `protect`, `env` names, `idle.timeout` | `/data` files |
| | `env` values, access mode, groups, role grants, Always active |

## Code-only changes

Change the code, keep the slug, keep `theme.css` (work inside the existing
direction; never quietly restyle an app), run `npm run check`, deliver.

## Schema changes: expand, then contract

The database survives every deploy, so a schema change is a **new migration
file**:

1. Edit `server/schema.ts`.
2. Run `npm run db:generate`. It adds `migrations/<NNNN>_<name>.sql`.
3. **Read the generated SQL.** Look for `DROP`, `ALTER ... TYPE` and
   `NOT NULL` on an existing table: each can fail or lose data.
4. Run `npm run check`, then deliver.

Rules:

- **Never edit, rename or delete a migration that was deployed.** The platform
  tracks applied files by name: an edit is ignored where it already ran, a
  rename runs again.
- **Expand, then contract.** Add a nullable column or a new table, ship the
  code that uses it; remove the old column only in a later version, once
  nothing reads it. The previous version then still runs against the new
  schema, so going back never needs a database restore.
- **No renames.** `drizzle-kit generate` stops and asks a question when it
  thinks something was renamed, and an agent cannot answer. Add the new
  column, copy the data in a hand-written step, drop the old one later.
- **A new `NOT NULL` column on a table with rows needs a default**
  (`.default(...)`) or the migration fails.
- **Never drop a column or table without the user's explicit agreement.**
- To copy or fix data, add a hand-written `.sql` file in `migrations/` whose
  name sorts after the last one (e.g. `0004_copy_titles.sql`). It runs once,
  in a transaction.

If a migration fails at deploy time, the platform restores the database from
the snapshot it took and keeps the live version. Nothing is lost; fix the
migration (it was never recorded as applied) and deploy again.

## Changing app.yaml

| Change | Effect on a live app |
|---|---|
| `access`, `groups` | **Ignored.** The dashboard owns access after creation; the deploy log says so. Tell the user to use the Access tab. |
| `roles` added | The role appears in the Access tab; nobody holds it until the user gives it. |
| `roles` removed | No longer sent to the app (`Remote-Roles` only carries declared roles). Grants stay stored and come back if the role is declared again. |
| `protect` | Applied at once by the gateway. |
| `env` name added | Declared; absent until the user types a value in Settings. |
| `env` name removed | No longer passed to the app. |
| `idle.timeout` | Applied. |
| `idle.warm` | Ignored if the user set **Always active** in Settings. |
| `database.enabled: true` (was off) | Creates the database. |
| `backend` removed | The container is removed; `/api` stops answering. |
| `slug` | **A different, new app** with an empty database. Never do it to "rename" an app; change `name` instead. |

## Delivering the change

- **ZIP hand-over**: `npm run zip`, give both archives, and tell the user to
  use **Deployments → Deploy a version** in the app's panel and read the
  summary (files, migrations, variables) before confirming.
- **ZIP upload**: `npm run deploy -- -m "<what changed>"`. The message goes
  into the version history the user reads when going back.
- **Git**: a branch and a pull request; the preview has an empty database, so
  check the migration there, then the user merges.

See [deploy-zip.md](deploy-zip.md) and [deploy-git.md](deploy-git.md).

## Going back

Every deploy is a numbered version. The last 10 keep their files, the last 3
their image and database snapshot. To go back:

- **Dashboard**: the app's **Deployments** tab, choose the version.
- **Deploy key**: list with `GET /api/apps/<slug>/releases`, then
  `POST /api/apps/<slug>/releases/<id>/rollback` with `{"database": false}`
  (commands in [deploy-zip.md](deploy-zip.md)).

Going back over a migration offers a choice:

- **keep the data** (`"database": false`, the default): the old code runs on
  the newer schema. Safe when migrations only expanded.
- **restore the database** (`"database": true`): the snapshot from before that
  migration comes back, and **everything written since is lost**. Only with
  the user's explicit agreement.

After going back, fix forward with a new version. In Git mode, also revert
the commit on the connected branch, or the next push brings the broken code
back.
