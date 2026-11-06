# Upgrading Nanodeploy

## Every update, automatically

Once `nanodeploy-update.timer` is installed, the server updates itself: every
five minutes it looks at `main` on GitHub, waits until every CI check of the new
commit is green, backs up everything, updates, checks that the console answers
with at least as many apps as before, and goes back to the previous commit if
not. A red commit is never deployed.

```bash
sudo cp nanodeploy-update.service nanodeploy-update.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now nanodeploy-update.timer
```

Edit `WorkingDirectory`, `ExecStart` and `User` in the service first (a user in
the docker group that owns the checkout). Follow it with
`journalctl -u nanodeploy-update -f`. Backups land in a `backups` directory next
to `APPS_DIR` (`BACKUP_DIR` in `.env` to change it); the last five are kept.

By hand, the same thing: `./scripts/update.sh`.

## From a version with tinyauth and Pocket ID, once

This upgrade replaces tinyauth and Pocket ID with gate, and moves every app to
the release layout. Do it by hand, the first time, with the steps below.

**What is kept, unchanged:** every app, its files, its Postgres database, its
`/data` volume, its environment values, its access mode and groups, its route.
Accounts and groups keep their ids, so every `ownerId` stored by an app still
points at the same person.

**What changes for people:** everyone signs in again. Passkeys cannot move
(they belong to Pocket ID's domain): each person gets a link to choose a password
or register a new passkey.

### 1. Check that the import can run

The control plane copies accounts out of Pocket ID through its API, with the key
the People tab already used:

```bash
grep '^POCKETID_API_KEY=.' .env
```

If that prints nothing, create a key in Pocket ID (admin, API keys) and put it in
`.env` first. Keep `POCKETID_ENCRYPTION_KEY` as it is.

### 2. Update the code and back up

```bash
git pull
```

```bash
./scripts/backup.sh
```

The backup runs against the version still running: every database, the app
files, every volume (Pocket ID and tinyauth included), and `.env`.

### 3. Install

```bash
./install.sh
```

It adds the new secrets to `.env` (`GATE_DB_PASSWORD`, `NANODEPLOY_SECRET_KEY`),
creates the `nanodeploy_build` network, starts Pocket ID for the import, builds
and restarts everything. Set `TIMEZONE` in `.env` (e.g. `Europe/Paris`) for the
analytics, then `docker compose up -d control-plane` if you changed it.

### 4. Sign in

```bash
docker compose logs control-plane | grep -A1 -E 'imported|SETUP'
```

You should see `imported N account(s) and M group(s) from Pocket ID`, then one
`SETUP` link per administrator. Open yours, choose a password, and add a passkey
from your account page. While the import has not succeeded, no link is printed
at all: a new administrator created by hand would end the import and break the
link between apps and their owners. If Pocket ID does not answer, the control
plane says so and tries again every minute.

### 5. Check the apps

Open `https://deploy.<your domain>`. Every app is listed, each with one version
"before versions" in its panel. Open a few: data owned by a person shows for
that person once they sign in.

### 6. Bring everyone back

People tab, "Sign-in link" on each person, and send them their link (one use,
seven days).

### 7. Clean up, once everyone is in

```bash
sed -i 's/^POCKETID_API_KEY=.*/POCKETID_API_KEY=/' .env
```

```bash
docker compose rm -sf pocket-id
```

```bash
docker compose up -d --remove-orphans
```

The last command removes the tinyauth container. Their volumes
(`nanodeploy_pocketid_data`, `nanodeploy_tinyauth_data`) stay until you delete
them; they are in the backup from step 2.

### 8. Turn on automatic updates

See the top of this page.

### Going back

Everything this upgrade adds to the database is additive, and each app's old
`dist` path still works through a link. To return to the previous version
completely, check out the commit recorded in the backup (`commit`) and restore
`postgres.sql.gz` and `apps.tar.gz` from it.
