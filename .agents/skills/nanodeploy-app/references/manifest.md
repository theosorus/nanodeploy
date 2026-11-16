# app.yaml reference

## Contents
- The template's app.yaml
- Every field
- Ready-made examples
- Writing rules (the zip tool reads a simple YAML subset)
- Common mistakes

`app.yaml` sits at the root of the app (or of the "Project directory" of a Git
connection). It is the only contract with the platform. The server validates
it on every deploy; `npm run zip`, `npm run deploy` and `npm run doctor`
validate it first with the same rules.

## The template's app.yaml

```yaml
name: Expenses
slug: expenses           # becomes expenses.<domain>
access: private          # public | private | groups, first deploy only
groups: []               # only used when access is groups
roles: []                # e.g. [moderator]; who holds them is set in the dashboard
protect: []              # e.g. - { path: /api/admin/*, role: moderator }
frontend: true
backend:
  entry: server.js       # bundled by npm run build, never a folder
  port: 3000
database:
  enabled: true
  migrations: ./migrations
idle:
  timeout: 10m           # stop after this much inactivity
  warm: false            # true = always running (~40 MB)
env: []                  # names only, e.g. [OPENAI_API_KEY]
# Git deployments only (a zip ignores it):
# build:
#   image: node:24-bookworm-slim
#   install: npm ci
#   command: npm run build
```

## Every field

| Field | Default | Rule | Applies |
|---|---|---|---|
| `name` | the slug | Display name, at most 60 characters. | every deploy |
| `slug` | **required** | 2 to 31 characters: lowercase letters, digits, single dashes; starts with a letter, ends with a letter or digit. Not `deploy`, `auth`, `id`, `www`. No `--`. | identity of the app |
| `access` | `private` | `private`, `groups` or `public`. | **first deploy only** |
| `groups` | `[]` | Group names, required and non-empty when `access: groups`. Letters, digits, `.`, `_`, `'`, `-`; at most 32. | first deploy only |
| `roles` | `[]` | Lowercase names like `moderator` (`[a-z][a-z0-9_-]*`, up to 32 characters); at most 16. | every deploy |
| `protect` | `[]` | `{ path, role }` items. `path` starts with `/` and may end with `*` only; `role` must be listed in `roles`. At most 32. | every deploy |
| `frontend` | `true` | `true` requires `dist/index.html` in the bundle. `false` for an API-only app. | every deploy |
| `backend` | **none** | A map `{ entry, port }`. **Leaving `backend` out means a static site with no server.** `entry` defaults to `server.js`, `port` to `3000`. | every deploy |
| `database.enabled` | **`false`** | `true` creates the app's database and sets `DATABASE_URL`. Leaving `database` out means no database. | every deploy |
| `database.migrations` | `./migrations` | Folder of `.sql` files inside the app. | every deploy |
| `idle.timeout` | `10m` | `<number><ms\|s\|m\|h>`, e.g. `30s`, `10m`, `1h`. | every deploy |
| `idle.warm` | `false` | `true` keeps the backend always running. The dashboard's **Always active** overrides it. | until set in the dashboard |
| `env` | `[]` | Variable names (`[A-Za-z_][A-Za-z0-9_]*`), at most 64. Not `DATABASE_URL`, `PORT` or proxy variables: the platform sets those. | every deploy |
| `build.image` | `node:24-bookworm-slim` | Docker image used for Git builds. | Git only |
| `build.install` | `npm ci` with a lockfile, else `npm install` | One line. `""` skips the install. | Git only |
| `build.command` | `npm run build` | One line. Must leave `dist/` and the entry file. | Git only |

Unknown keys are ignored. Changing `slug` makes a **different app** with an
empty database; in a Git-connected repository the build fails on purpose.

## Ready-made examples

**Private tool with a database** (the most common case): the template as is,
with your `name` and `slug`.

**Public app with a moderated back office**: anyone reads and posts, people
holding `moderator` delete.

```yaml
name: Guestbook
slug: guestbook
access: public
roles: [moderator]
protect:
  - { path: /api/admin/*, role: moderator }
frontend: true
backend: { entry: server.js, port: 3000 }
database: { enabled: true, migrations: ./migrations }
idle: { timeout: 10m, warm: false }
env: []
```

The route under `/api/admin/` still calls `requireRole(c, "moderator")`: two
locks, so a typo in `protect` never opens it. Who is a moderator is decided in
the dashboard (Access tab, Roles).

**Shared with a group only**:

```yaml
access: groups
groups: [family]
```

The group must exist in the dashboard (People & access). After the first
deploy, change access in the dashboard, not here.

**Static site, no server, no database**: no `backend`, no `database`.

```yaml
name: Wedding
slug: wedding
access: public
frontend: true
```

**App calling a paid API**:

```yaml
env: [OPENAI_API_KEY]
```

The server reads `process.env.OPENAI_API_KEY`. The user types the value in the
app's Settings tab. Until then the variable is absent, so the route that needs
it must answer `503 {"error":"OPENAI_API_KEY is not set yet"}` instead of
crashing.

## Writing rules

`npm run zip`, `npm run deploy` and `npm run doctor` read a simple subset of
YAML. Stay inside it:

- Indent with spaces, never tabs.
- One `key: value` per line; nested maps indented under their key.
- Lists on one line `[a, b]`, or one `- item` per line.
- A list of maps uses one-line maps: `- { path: /api/admin/*, role: moderator }`.
- No multi-line strings (`|`, `>`), anchors or aliases.
- Comments start with ` #`.

## Common mistakes

| Mistake | Effect | Fix |
|---|---|---|
| Template values `name: Mon app`, `slug: mon-app` left in | doctor refuses | Write the app's own name and slug. |
| `backend` removed while `server.js` is needed | The API never runs, `/api` answers 404 | Keep the `backend` map. |
| `database` left out but the code uses `DATABASE_URL` | Crash on first query | `database: { enabled: true, migrations: ./migrations }` |
| `access: public` added to an existing app | Ignored, the deploy log says so | Change access in the dashboard. |
| `protect` role not in `roles` | Refused | Add the role to `roles`. |
| `slug` with `_`, uppercase, or ending with `-` | Refused | Lowercase letters, digits, single dashes. |
| `env: [DATABASE_URL]` or `[PORT]` | Refused | Remove it: the platform sets it. |
| Secret value written in `app.yaml` | Leaks the secret into every zip and commit | Names only; values in the dashboard. |
