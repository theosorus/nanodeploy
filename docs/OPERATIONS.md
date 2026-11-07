# Operating Nanodeploy

[Installation](INSTALL.md) · [Upgrades](UPGRADING.md) · [Security](../SECURITY.md)

## Back up

Run `./scripts/backup.sh` from the checkout. `BACKUP_DIR` defaults to a sibling
`backups` directory beside `APPS_DIR`; `BACKUP_KEEP` defaults to five. Use a
dedicated backup directory, with enough space for every app and database.
The script does not install a schedule. Set up your own timer or run it before
changes; the optional updater takes a backup before each update.

Each timestamped directory contains:

| File | Contents |
| --- | --- |
| `postgres.sql.gz` | All databases, SQL roles and their password hashes. |
| `apps.tar.gz` | App bundles, releases and database migration snapshots. |
| `volume-nanodeploy_*.tgz` | App data volumes and persistent gateway/legacy identity volumes. |
| `env` | Configuration, root deploy token and encryption key. |
| `commit` | Git revision used by this installation. |

The script reads app files through Docker so container-owned files are included.
It excludes transient build/staging directories. PostgreSQL dumps are logical
backups; apps writing to both SQL and `/data` should be stopped during the
backup if those two stores need a single consistent point in time. Protect and
encrypt off-host copies. Periodically test restoration on a spare host.

## Restore a backup

Use a **replacement host with no existing Nanodeploy data**, the same CPU
architecture and the same public domain. This procedure replaces the fresh
platform database; do not run it over a live installation. Changing domains
also changes WebAuthn origins, so existing passkeys may need re-enrollment.

1. Install the prerequisites from [INSTALL.md](INSTALL.md). Clone Nanodeploy,
   check out the revision recorded in `commit`, and copy the backup's `env`
   to `.env` with mode `600`. Preserve all secret values, especially
   `NANODEPLOY_SECRET_KEY`. If you change `APPS_DIR`, create the new directory
   and update its absolute path before continuing. Keep backup archives
   outside that directory.
2. Run `./install.sh` to create networks and images. Once the empty platform
   starts, stop it with `docker compose stop`. Ignore the setup link from this
   empty database: the restored accounts replace it.
3. Restore `apps.tar.gz` into `APPS_DIR`. The archive has one top-level
   directory (the old app directory's basename). Strip that component when
   extracting into a new directory, preserving ownership and permissions:

   ```bash
   # Set these two paths explicitly for the replacement host.
   NANODEPLOY_BACKUP=/absolute/path/to/the/backup
   NANODEPLOY_RESTORE_APPS=/absolute/path/from/APPS_DIR
   sudo tar -xzf "$NANODEPLOY_BACKUP/apps.tar.gz" \
     --strip-components=1 -C "$NANODEPLOY_RESTORE_APPS"
   ```

4. Restore each `volume-<name>.tgz` into the identically named Docker volume,
   with every platform/app container stopped. For example, replacing the
   example name with one present in your backup:

   ```bash
   docker volume create nanodeploy_data_my-app
   docker run --rm --network none --read-only --user 0:0 \
     -v nanodeploy_data_my-app:/restore \
     -v "$NANODEPLOY_BACKUP:/backup:ro" \
     postgres:16-alpine tar -xzf /backup/volume-nanodeploy_data_my-app.tgz -C /restore
   ```

   Use the PostgreSQL image version in the saved `.env` if it differs.
   Restore gateway and legacy identity archives too when present. Do not
   restore a raw PostgreSQL data volume over a logical dump.
5. Start **only Postgres** with `docker compose up -d postgres`, and wait for
   `docker compose exec -T postgres pg_isready -h 127.0.0.1 -U postgres` to succeed.
   Remove the database and gate role created by the empty installation, then
   import the dump. The `sed` below removes only the creation of the built-in
   `postgres` role, which already exists on the replacement host:

   ```bash
   docker compose exec -T postgres psql -X -U postgres -d postgres \
     -v ON_ERROR_STOP=1 \
     -c 'DROP DATABASE nanodeploy WITH (FORCE)' \
     -c 'DROP ROLE IF EXISTS nd_gate'
   set -o pipefail
   gzip -dc "$NANODEPLOY_BACKUP/postgres.sql.gz" \
     | sed '/^CREATE ROLE postgres;$/d' \
     | docker compose exec -T postgres psql -X -U postgres -d postgres -v ON_ERROR_STOP=1
   ```

   Do not continue if the import reports an error. This procedure assumes
   the current PostgreSQL 16 layout and a genuinely fresh target; older
   versions may need their own [PostgreSQL restore procedure](https://www.postgresql.org/docs/16/backup-dump.html).
6. Run `docker compose up -d`. The control plane recreates app images,
   containers and Caddy routes from restored state. Check logs for failed
   reconciliation. Verify administrator login, a database-backed app, a file
   in an app's `/data`, a sleeping app waking and access to a public HTTPS API.
7. Restore DNS/proxy routing if the host changed. Regenerate systemd units
   with `./scripts/configure-systemd.sh` when available in the restored
   revision. Enable optional update/backup timers only after verifying data.

Keep the source backup until recovery has been verified. A code-only rollback
across the secret-encryption migration is insufficient; the matching database,
app files and environment must be restored together.

## Updates and shutdown

Use the [upgrade guide](UPGRADING.md), including its migration notes. Back up
before manual updates. Do not point an automatic updater at a branch you do
not trust: platform code and Docker access have host administrator power.

Use `docker compose stop` for a temporary shutdown, and `docker compose up -d`
to resume. External networks persist independently of Compose. App databases
and volumes are not deleted by a normal deployment. Commands such as
`docker compose down -v` or `docker volume prune` can destroy persistent state.

## Configuration and forks

Keep configuration in `.env`, private automation in `.local/`, and generated
units/data in `var/`. These are ignored by Git. The tracked `.env.example`
contains no credentials. A fork should keep these boundaries and retain the
MIT copyright notice and bundled third-party notices.

The updater derives the GitHub repository from `origin` and follows
`UPDATE_BRANCH` (default `main`). It needs a public GitHub remote with Actions
checks; private repositories and other forges need their own authenticated
update mechanism. Hosting apps from GitLab is independent of this limitation.
