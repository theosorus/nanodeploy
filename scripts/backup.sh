#!/usr/bin/env bash
# A full backup of this Nanodeploy install, enough to rebuild it elsewhere:
# every database (pg_dumpall, roles included), the app files (releases and
# database snapshots), every app's /data volume, the platform's own volumes
# (caddy, and pocket-id or tinyauth if they are still around), .env and the
# commit it ran. scripts/update.sh takes one before every update.
#
#   ./scripts/backup.sh            -> $BACKUP_DIR/<date>/ (keeps the last 5)
#
# BACKUP_DIR defaults to a "backups" directory next to APPS_DIR. It holds
# secrets and app data in clear: keep it on the server, and encrypt any copy
# that leaves it.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
. ./.env
set +a

DEST_ROOT=${BACKUP_DIR:-$(dirname "$APPS_DIR")/backups}
KEEP=${BACKUP_KEEP:-5}
dest="$DEST_ROOT/$(date +%Y%m%d-%H%M%S)"
umask 077
mkdir -p "$dest"
say() { printf '[backup] %s\n' "$1"; }

say "databases"
docker compose exec -T postgres pg_dumpall -U postgres | gzip >"$dest/postgres.sql.gz"
# an empty dump means postgres did not answer: a backup that restores nothing is
# worse than none, because it looks like one
[ "$(gzip -dc "$dest/postgres.sql.gz" | head -c 100 | wc -c)" -gt 0 ] || { say "pg_dumpall produced nothing"; exit 1; }

say "app files"
apps_name=$(basename "$APPS_DIR")
# Release directories and database snapshots can belong to the control-plane
# container. Read them through the same local image used for volume backups,
# without changing their permissions or granting the container write access.
image="postgres:${POSTGRES_VERSION:-16-alpine}"
docker run --rm --network none --read-only --user 0:0 \
  -v "$APPS_DIR:/source/$apps_name:ro" "$image" \
  tar --exclude="$apps_name/.builds" --exclude="$apps_name/.staging" \
    -C /source -czf - "$apps_name" >"$dest/apps.tar.gz"

say "volumes"
# tar from an image already on the machine: nothing is pulled during a backup
for v in $(docker volume ls -q | grep -E '^nanodeploy_(data_.+|pocketid_data|tinyauth_data|caddy_data|caddy_config)$' || true); do
  docker run --rm -v "$v":/v:ro -v "$dest":/b "$image" tar czf "/b/volume-$v.tgz" -C /v .
done

cp .env "$dest/env"
git rev-parse HEAD >"$dest/commit"
say "done: $dest ($(du -sh "$dest" | cut -f1))"

# keep the most recent ones
mapfile -t old < <(find "$DEST_ROOT" -mindepth 1 -maxdepth 1 -type d | sort | head -n -"$KEEP")
for d in "${old[@]}"; do rm -rf "$d"; done
