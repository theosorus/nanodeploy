#!/usr/bin/env bash
# Nanoploy installer. Run once on the server, as a user in the docker group.
set -euo pipefail

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$1"; }
ok() { printf '  \033[32mok\033[0m %s\n' "$1"; }

say "1/5 checking the host"

command -v docker >/dev/null || { echo "docker is required"; exit 1; }
docker compose version >/dev/null || { echo "docker compose v2 is required"; exit 1; }
ok "docker present"

# docker data-root should not sit on the SD card
DATA_ROOT=$(docker info --format '{{.DockerRootDir}}')
case "$DATA_ROOT" in
  /var/lib/docker) warn "docker data-root is $DATA_ROOT, move it to external storage (see README)";;
  *) ok "data-root on $DATA_ROOT";;
esac

# log rotation, a full disk is the classic homelab death
if ! docker info 2>/dev/null | grep -qi 'Logging Driver: local'; then
  if ! grep -qs 'max-size' /etc/docker/daemon.json; then
    warn "no docker log rotation configured, see README section 'host prep'"
  fi
fi

# JetPack 4 ships a seccomp too old for bookworm-based images
if [ -f /etc/nv_tegra_release ]; then
  SECCOMP=$(dpkg-query -W -f='${Version}' libseccomp2 2>/dev/null || echo 0)
  ok "jetson detected, libseccomp2=$SECCOMP (needs >= 2.5)"
fi

say "2/5 preparing directories"
source_env() { set -a; . ./.env; set +a; }

if [ ! -f .env ]; then
  cp .env.example .env
  gen() { openssl rand -hex 24; }
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(gen)|" .env
  sed -i "s|^POCKETID_ENCRYPTION_KEY=.*|POCKETID_ENCRYPTION_KEY=$(gen)|" .env
  sed -i "s|^DEPLOY_TOKEN=.*|DEPLOY_TOKEN=$(gen)|" .env
  ok "generated .env with fresh secrets"
  warn "edit .env now to set APPS_DOMAIN and APPS_DIR, then run install.sh again"
  exit 0
fi

source_env
mkdir -p "$APPS_DIR"
docker network create nanoploy_edge 2>/dev/null && ok "network nanoploy_edge" || ok "network nanoploy_edge exists"
docker network create --internal nanoploy_data 2>/dev/null && ok "network nanoploy_data" || ok "network nanoploy_data exists"
docker network create nanoploy_apps 2>/dev/null && ok "network nanoploy_apps" || ok "network nanoploy_apps exists"
ok "apps dir $APPS_DIR"

say "3/5 building the caddy image with the sablier plugin"
warn "this compiles caddy from source, ~10 min on a Jetson"
docker compose build caddy

say "4/5 starting the platform"
docker compose up -d
ok "containers up"

say "5/5 next steps"
cat <<TXT

  1. Point a Cloudflare tunnel at http://localhost:8080 with a wildcard
     hostname *.$APPS_DOMAIN plus $APPS_DOMAIN itself.
  2. Open https://id.$APPS_DOMAIN and create your Pocket ID admin account.
  3. In Pocket ID, create an OIDC client for tinyauth with callback
     https://auth.$APPS_DOMAIN/api/oauth/callback/generic
     then put the client id and secret in .env and run:
       docker compose up -d tinyauth
  4. To bring everything back after a power cut:
       sudo cp nanoploy.service /etc/systemd/system/
       sudo systemctl daemon-reload && sudo systemctl enable nanoploy
     Adjust WorkingDirectory and RequiresMountsFor inside the file first.
  5. Your deploy token is in .env as DEPLOY_TOKEN. Keep it in your password
     manager, the CLI needs it.

TXT
