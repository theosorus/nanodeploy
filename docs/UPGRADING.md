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

## Security upgrade: 7 November 2026

Install this upgrade manually the first time. It changes the storage format of
application secrets and the network/runtime security baseline. An updater from
an older checkout only knows how to roll code back and cannot safely reverse
the encryption migration.

1. Suspend `nanodeploy-update.timer` for this first upgrade and run
   `./scripts/backup.sh` before updating the checkout. Verify the backup includes
   `postgres.sql.gz`, `apps.tar.gz`, app data volumes, `env` and `commit`. Store a
   protected copy outside the host; full backups contain the encryption key.
2. Preserve the existing `NANODEPLOY_SECRET_KEY` exactly. The installer generates
   one only for installations that never had one. Do not replace a key already
   used for forge credentials.
3. Update the checkout and run `./install.sh`. It creates the pairwise platform
   networks and the internal build network without a host gateway, builds Caddy
   2.11.9 or newer, and recreates the services. The control plane encrypts legacy
   environment/password rows, rebuilds older backend images with Node 24 and
   moves each app to its own internal bridge. Plan for application restarts;
   old, insufficiently isolated containers are removed even if rebuilding fails.
4. Set `TRUSTED_PROXY_CIDRS` in `.env` to the actual tunnel/reverse proxy source
   addresses seen by Caddy. Do not trust every private network. Recreate Caddy
   after editing it. Incorrect addresses collapse visitor rate limits onto the
   proxy's address.
5. Check console login, an existing backend/database, a sleeping app waking and
   an outgoing public API call. Apps/builders now reach public HTTP/S through
   `http://egress:3128`; other HTTP libraries must honour the proxy variables.
   Private APIs, SMTP and arbitrary TCP have no default route. Previews have
   their own environment; supply preview-specific credentials explicitly.
6. Check startup logs for failed app reconciliation, verify backend containers
   carry `nanodeploy.security=2026-11-isolation-egress-v1`, use only their own
   `nanodeploy_app_<slug>` network, and carry a `nanodeploy.runtime=node24-2026-11`
   image label. Resume the update timer after these checks.

If the upgrade fails, prefer fixing forward. **Returning to a pre-encryption
binary requires restoring the matching pre-upgrade database, app files and
`.env` together.** A code-only rollback cannot read the migrated environment
values or passwords. The updated updater refuses this incompatible rollback,
keeps the new checkout, and stops the control plane for recovery. Normal app
release rollbacks remain available and keep the encryption format.

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
creates the isolated platform/build networks, starts Pocket ID for the import, builds
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

Each app's old `dist` path still works through a link. The security upgrade
also encrypts existing secret values, so returning to an older binary requires
restoring the matching database and `.env`. Check out the commit recorded in
the backup (`commit`) and restore `postgres.sql.gz`, `apps.tar.gz` and the saved
environment together. Restore the app data volumes too when recovering the
entire installation from that backup.
