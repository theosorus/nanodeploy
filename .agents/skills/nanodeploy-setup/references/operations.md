# Operations: backups, restore, updates

## Contents
- Everyday commands
- Back up
- Restore
- Update by hand
- Automatic updates
- Start on boot
- Uninstall

All commands run from the checkout, as its owner.

## Everyday commands

```bash
docker compose ps                                  # status
docker compose logs --tail=100 gate control-plane  # recent logs
docker compose stop                                # stop everything (data kept)
docker compose up -d                               # start again
./install.sh --check                               # validate config, change nothing
```

Never `docker compose down -v`, `docker volume prune` or deleting `APPS_DIR`.

## Back up

```bash
./scripts/backup.sh
```

It writes a timestamped folder (default: `backups/` next to `APPS_DIR`, five
kept; `BACKUP_DIR` and `BACKUP_KEEP` in `.env` change that) containing:

| File | Content |
|---|---|
| `postgres.sql.gz` | Every database and role |
| `apps.tar.gz` | Releases, app files, migration snapshots |
| `volume-nanodeploy_*.tgz` | Each app's `/data` and the platform volumes |
| `env` | `.env`, including `DEPLOY_TOKEN` and `NANODEPLOY_SECRET_KEY` |
| `commit` | The Nanodeploy revision |

A backup holds every secret and personal data: encrypt it and keep a copy on
another machine. No schedule is installed; suggest a systemd timer or cron
job calling the script, and test a restore once on a spare machine. For an
app writing to both Postgres and `/data`, stop its backend during the backup
if the two must match exactly.

## Restore

Restoring replaces a fresh platform's database: only on a **new, empty host**
with the same CPU architecture and the same domain, never over a live
install. Confirm with the user first. The procedure has seven precise steps
(revision checkout, `.env`, `apps.tar.gz` with `--strip-components=1`, each
volume, then the Postgres dump with one `sed` filter, then
`docker compose up -d`): follow `docs/OPERATIONS.md`, section "Restore a
backup", in the repository, exactly. Keep the source backup until the
restore is verified (sign-in, a database app, a `/data` file, a wake-up, an
outbound API call).

## Update by hand

1. Read `docs/UPGRADING.md` in the new revision for one-time steps.
2. `./scripts/backup.sh`, and check the backup folder is complete.
3. `git pull --ff-only` (or check out the chosen revision).
4. `./install.sh`
5. Check: console sign-in, an app with a database, a sleeping app waking.

Keep `NANODEPLOY_SECRET_KEY` unchanged. If an update fails, prefer fixing
forward; a code rollback across a data-format change needs the matching
backup restored, as `docs/UPGRADING.md` explains.

## Automatic updates

Optional and off by default. Once installed, every five minutes the updater
checks `main` on the public GitHub repository configured as `origin`, waits
for its CI to be green, backs up, updates, and checks the console still lists
every app. It rolls back on failure only when the storage format is compatible;
otherwise it keeps the new checkout and stops the control plane for recovery.
See `docs/UPGRADING.md`. It needs Python 3, curl and `flock`.

```bash
./scripts/configure-systemd.sh
cat var/systemd/nanodeploy-update.service      # check paths and User
sudo cp var/systemd/nanodeploy-update.service var/systemd/nanodeploy-update.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now nanodeploy-update.timer
journalctl -u nanodeploy-update -f
```

Never point it at a branch the user does not trust: platform code controls
Docker, hence the whole host. Private repositories and other forges need a
manual update instead.

## Start on boot

See section 9 of [server-install.md](server-install.md). Without systemd,
start `docker compose up -d` from the machine's own supervisor.

## Uninstall

Confirm with the user, then: back up; disable the systemd units; delete the
apps from the console; `docker compose stop` then `docker compose down`.
Remove volumes and `APPS_DIR` only if the user explicitly wants the data
erased.
