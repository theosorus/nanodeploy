# Deploying with a ZIP archive

## Contents
- The two archives
- What the deploy archive must contain
- Make the archives
- Mode A: hand the archives to the user
- Mode B: upload with a deploy key
- Check, then go back if needed
- Without npm run zip
- Never

Two modes use the same archive. **Hand-over** (mode A) is the default: you
build, the user drops the file on the dashboard. **Upload** (mode B) is for
when the user gave you a deploy key: `npm run deploy` sends the same archive
itself.

## The two archives

`npm run zip` writes two files. The user gets both, every time.

| File | Content | What the user does with it |
|---|---|---|
| `<slug>-deploy.zip` | The built app: `app.yaml`, `dist/`, `server.js`, `migrations/` at the top level | Drops it on the dashboard. This is what runs. |
| `<slug>-source.zip` | The project in a `<slug>/` folder, without `node_modules`, build output or `.env` | Keeps it, to change the app later (give it back to an agent) or push it to Git. The dashboard refuses it on purpose. |

## What the deploy archive must contain

The server checks this on every upload and refuses the archive otherwise:

- exactly one `app.yaml`, **at the top level of the archive**, not inside a
  folder;
- `dist/index.html` when `frontend` is true (the built page, not the source
  `index.html`);
- the backend entry (`server.js`) when app.yaml has a `backend`, bundled into
  one file;
- the `.sql` migrations under the `migrations/` folder when the database is
  enabled;
- forward slashes in paths, no absolute paths, no `..`, no symbolic links, no
  password-protected zip;
- at most 100 MB compressed, 512 MB unpacked, 5000 files, 64 MB per file.

`npm run zip` produces exactly this and checks it first. Do not build the
archive any other way unless the section "Without npm run zip" applies.

## Make the archives

From the app folder (the one holding `app.yaml` and `package.json`):

```bash
npm run zip
```

It runs, in order: typecheck, tests, build, doctor, then writes the two
archives next to `app.yaml` and prints their full paths. If it prints
`No archive written` or an `ERROR`, fix each listed problem and run it again.
Loop until it prints `Nanodeploy archives for "<slug>" are ready.`

To write them somewhere else:

```bash
npm run zip -- --out-dir <folder>
```

Where to put them so the user can download them:

- **claude.ai**: `npm run zip -- --out-dir /mnt/user-data/outputs` (or the
  outputs folder your environment shows to the user).
- **Local agent**: leave them in the app folder and give the user their full
  paths, as printed.

## Mode A: hand the archives to the user

Give both files, then these steps, in the user's language. Adapt the first
block to a new or an existing app.

**A new app**

1. Open the console at `https://deploy.<your domain>`.
2. Click **New application**, choose **ZIP archive**.
3. Drop `<slug>-deploy.zip`. A new app goes live at once.
4. Open `https://<slug>.<your domain>` and sign in.

**A new version of an existing app**

1. Open the console, then the app.
2. In **Deployments**, click **Deploy a version** and drop `<slug>-deploy.zip`.
3. Read what will change (files, migrations, variables to set), then confirm.
   Nothing goes live before that. A zip made for another app is refused there.

**Then, if it applies**

- Variables listed in `env`: the app's **Settings** tab, **Environment
  variables**, type each value. Name each variable and where the user gets
  its value.
- Roles: the app's **Access** tab, **Roles**, give each role to people or
  groups.
- Access: `access` in app.yaml only counts at creation. To change it later:
  the **Access** tab.

Tell the user to keep `<slug>-source.zip`: it is the only copy of the source
outside this conversation.

## Mode B: upload with a deploy key

You need two values from the user:

- `NANODEPLOY_URL`: the console address, `https://deploy.<domain>` (for a
  local trial, `http://deploy.apps.localhost:8080`). Not the app's address.
- `NANODEPLOY_TOKEN`: a **deploy key** `ndd_...` for this exact slug. The user
  creates it under **New application → Terminal & agents** (an app that does
  not exist yet) or in the app's **Settings → Deploy keys**.

Never ask for the server's `DEPLOY_TOKEN`: it controls the whole machine. A
deploy key controls one app.

Set them in your shell, then deploy with a message saying what changed:

```bash
# bash / zsh
export NANODEPLOY_URL=https://deploy.apps.example.com
export NANODEPLOY_TOKEN=ndd_...
npm run check
npm run deploy -- -m "Add the shopping list"
```

```powershell
# PowerShell
$env:NANODEPLOY_URL = "https://deploy.apps.example.com"
$env:NANODEPLOY_TOKEN = "ndd_..."
npm run check
npm run deploy -- -m "Add the shopping list"
```

`npm run deploy` builds, checks the archive like `npm run zip`, uploads it,
and prints the app URL then the platform's log. Read the log:

- `env X is declared but not set yet`: tell the user to type that value in
  Settings.
- `access kept as "..."`: app.yaml asked for another access mode; the
  dashboard keeps its own. Tell the user if they meant to change it.
- `WARNING: <host> does not resolve`: the server's DNS lacks the wildcard
  record. The app runs but nobody can reach it; the server owner must fix DNS.
- `deploy failed: ...` with `the running version was left untouched`: nothing
  changed online. Fix the cause and deploy again.

Also give the user both archives (`npm run zip`), so they keep the source.

## Check, then go back if needed

A successful deploy does not start the server: the first visit does. So:

1. Ask the user to open the app once (or open it yourself if it is public).
2. With a deploy key, read the backend's recent output:

```bash
curl -s -H "Authorization: Bearer $NANODEPLOY_TOKEN" "$NANODEPLOY_URL/api/apps/<slug>/logs"
```

   It returns `{"lines": [...]}`. An empty list on a sleeping app is normal.

3. If the new version is broken, go back to the previous one, then fix forward:

```bash
curl -s -H "Authorization: Bearer $NANODEPLOY_TOKEN" "$NANODEPLOY_URL/api/apps/<slug>/releases"
curl -s -X POST -H "Authorization: Bearer $NANODEPLOY_TOKEN" -H "content-type: application/json" \
  -d '{"database": false}' "$NANODEPLOY_URL/api/apps/<slug>/releases/<id>/rollback"
```

   Use the `id` (not the `number`) of the version to return to.
   `"database": false` keeps the data; `true` restores the snapshot taken
   before that version's migrations and **loses everything written since**:
   only with the user's explicit agreement. Without a key, the user does the
   same from the **Deployments** tab.

## Without npm run zip

`npm run zip` needs Node 24 or newer. If Node exists but the script cannot run,
build with `npm run build`, then archive **from inside the app folder** so
`app.yaml` sits at the top level:

```bash
# Linux, macOS
zip -r ../my-slug-deploy.zip app.yaml dist server.js migrations
```

```powershell
# Windows 10 or later (tar.exe is built in and writes valid zip paths)
tar -a -c -f ..\my-slug-deploy.zip app.yaml dist server.js migrations
```

If there is no Node at all, you cannot build the deploy archive: say so, give
the source, and suggest a Git deployment, where the server builds
([deploy-git.md](deploy-git.md)).

## Never

- Zip the app **folder** itself, or a parent folder: `app.yaml` ends up inside
  a folder and the archive is refused.
- Use PowerShell's `Compress-Archive`: on Windows PowerShell 5.1 it writes
  backslashes in paths, and the server refuses them as unsafe.
- Put `node_modules`, `.env`, secrets or source files in the deploy archive.
- Hand over only the source archive and call it deployable.
- Hand-edit files inside `dist/` or `server.js`: change the source and rebuild.
