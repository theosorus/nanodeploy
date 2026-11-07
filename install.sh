#!/usr/bin/env bash
# Nanodeploy installer. Run once on the server, as a user in the docker group.
set -euo pipefail
umask 077

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$1"; }
ok() { printf '  \033[32mok\033[0m %s\n' "$1"; }
die() { printf '\n  \033[31mx %s\033[0m\n\n' "$1"; exit 1; }

say "1/5 checking the host"

command -v docker >/dev/null || die "docker is required"
docker compose version >/dev/null || die "docker compose v2 is required"
command -v openssl >/dev/null || die "openssl is required to generate the secrets"
docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon: add your user to the docker group, then log out and back in"
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

# sed -i is not portable (GNU wants no argument, BSD wants one): rewrite the
# file instead, so the installer also works when run from a mac
set_var() {
  local tmp
  tmp=$(mktemp)
  awk -v k="$1" -v v="$2" '{ if (index($0, k "=") == 1) print k "=" v; else print }' .env >"$tmp"
  mv "$tmp" .env
}

if [ ! -f .env ]; then
  cp .env.example .env
  set_var POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  set_var DEPLOY_TOKEN "$(openssl rand -hex 24)"
  set_var GATE_DB_PASSWORD "$(openssl rand -hex 24)"
  set_var NANODEPLOY_SECRET_KEY "$(openssl rand -hex 32)"
  chmod 600 .env
  ok "generated .env with fresh secrets"
  warn "edit .env now to set APPS_DOMAIN and APPS_DIR, then run install.sh again"
  exit 0
fi

# an .env from before gate existed: add its secret instead of asking for a
# reinstall
if ! grep -q '^GATE_DB_PASSWORD=.' .env; then
  grep -q '^GATE_DB_PASSWORD=' .env || printf '\nGATE_DB_PASSWORD=\n' >> .env
  set_var GATE_DB_PASSWORD "$(openssl rand -hex 24)"
  ok "added GATE_DB_PASSWORD to .env"
fi

# same for the key that encrypts forge credentials (Git deploys)
if ! grep -q '^NANODEPLOY_SECRET_KEY=.' .env; then
  grep -q '^NANODEPLOY_SECRET_KEY=' .env || printf '\nNANODEPLOY_SECRET_KEY=\n' >> .env
  set_var NANODEPLOY_SECRET_KEY "$(openssl rand -hex 32)"
  ok "added NANODEPLOY_SECRET_KEY to .env"
fi

chmod 600 .env
source_env

# Old .env files otherwise keep pinning the vulnerable gateway on upgrades.
if ! awk -v version="${CADDY_VERSION:-0}" 'BEGIN {
  n=split(version,v,"."); exit !(n==3 && (v[1]>2 || (v[1]==2 && (v[2]>11 || (v[2]==11 && v[3]>=9)))))
}'; then
  grep -q '^CADDY_VERSION=' .env || printf '\nCADDY_VERSION=\n' >> .env
  set_var CADDY_VERSION 2.11.9
  export CADDY_VERSION=2.11.9
  ok "upgraded Caddy to the security minimum 2.11.9"
fi

# every one of these has cost someone an evening of debugging
[ -n "${APPS_DOMAIN:-}" ] || die "APPS_DOMAIN is empty in .env"
[ "$APPS_DOMAIN" != "apps.example.com" ] || die "APPS_DOMAIN is still the example value, set your own domain in .env"
case "$APPS_DOMAIN" in *.*) ;; *) die "APPS_DOMAIN must be a domain name, got '$APPS_DOMAIN'";; esac
[ -n "${APPS_DIR:-}" ] || die "APPS_DIR is empty in .env"
case "$APPS_DIR" in /*) ;; *) die "APPS_DIR must be an absolute path, got '$APPS_DIR'";; esac
for secret in POSTGRES_PASSWORD DEPLOY_TOKEN GATE_DB_PASSWORD NANODEPLOY_SECRET_KEY; do
  eval "value=\${$secret:-}"
  [ -n "$value" ] || die "$secret is empty in .env, delete .env and rerun to regenerate the secrets"
done
[[ "$NANODEPLOY_SECRET_KEY" =~ ^[0-9a-fA-F]{64}$ ]] || die "NANODEPLOY_SECRET_KEY must contain exactly 64 hexadecimal characters; preserve an existing encryption key"
# an empty or short token would make the caddy CLI bypass match almost anything
[ "${#DEPLOY_TOKEN}" -ge 24 ] || die "DEPLOY_TOKEN must be at least 24 characters"
ok "configuration looks sane"

mkdir -p "$APPS_DIR"
chmod 755 "$APPS_DIR"
mkdir -p "$APPS_DIR/.snapshots" "$APPS_DIR/.builds" "$APPS_DIR/.staging"
docker network create nanodeploy_edge 2>/dev/null && ok "network nanodeploy_edge" || ok "network nanodeploy_edge exists"
docker network create --internal nanodeploy_data 2>/dev/null && ok "network nanodeploy_data" || ok "network nanodeploy_data exists"
docker network create nanodeploy_apps 2>/dev/null && ok "network nanodeploy_apps" || ok "network nanodeploy_apps exists"
docker network create nanodeploy_build 2>/dev/null && ok "network nanodeploy_build" || ok "network nanodeploy_build exists"
docker network create nanodeploy_egress 2>/dev/null && ok "network nanodeploy_egress" || ok "network nanodeploy_egress exists"
if ! docker network inspect nanodeploy_build_secure >/dev/null 2>&1; then
  docker network create --internal --opt com.docker.network.bridge.inhibit_ipv4=true nanodeploy_build_secure >/dev/null
fi
[ "$(docker network inspect -f '{{.Internal}}' nanodeploy_build_secure)" = true ] || die "nanodeploy_build_secure must be internal"
[ "$(docker network inspect -f '{{index .Options "com.docker.network.bridge.inhibit_ipv4"}}' nanodeploy_build_secure)" = true ] || die "nanodeploy_build_secure must not expose a host gateway"
# Pairwise platform networks: neither gate, Caddy nor Sablier can reach the
# control plane's Docker proxy. Existing app containers migrate at reconcile.
docker network create nanodeploy_console 2>/dev/null && ok "network nanodeploy_console" || ok "network nanodeploy_console exists"
for net in wake docker sablier_control gate_data legacy; do
  network="nanodeploy_$net"
  if ! docker network inspect "$network" >/dev/null 2>&1; then
    docker network create --internal "$network" >/dev/null
  fi
  [ "$(docker network inspect -f '{{.Internal}}' "$network")" = true ] || die "$network must be an internal Docker network"
  ok "network $network"
done
ok "apps dir $APPS_DIR"

say "3/5 building the gateway and platform images"
docker compose pull --ignore-buildable
warn "this compiles caddy from source, ~10 min on a Jetson"
docker compose build --pull

say "4/5 starting the platform"
# Upgrading from Pocket ID: it must answer while the control plane imports the
# accounts with their ids. Started here only while a key is configured; clear
# POCKETID_API_KEY in .env once everyone has signed in to stop it for good.
if [ -n "${POCKETID_API_KEY:-}" ]; then
  docker compose --profile legacy up -d pocket-id
  ok "pocket-id running for the account import"
fi
# --build: an upgrade changes the control plane and gate, not only caddy
docker compose up -d --build
ok "containers up"

say "5/5 next steps"
PORT=${CADDY_PORT:-8080}
cat <<TXT

  1. Point a reverse proxy or tunnel at http://localhost:$PORT with a WILDCARD
     hostname *.$APPS_DOMAIN plus $APPS_DOMAIN itself. It must terminate TLS:
     caddy speaks plain http behind it.
     Without the wildcard, apps deploy and run but no browser can resolve them.
     Cloudflare tunnel: one Public Hostname entry, subdomain "*", service
     HTTP -> localhost:$PORT.
  2. Create your administrator account. The control plane prints a one-time
     link for it in its logs:
       docker compose logs control-plane | grep -A1 SETUP
     Open it, choose a password, then add a passkey from your account page.
     Upgrading from Pocket ID? Start it once before this step so its accounts
     are imported with their ids:
       docker compose --profile legacy up -d pocket-id
       docker compose restart control-plane
  3. Open https://deploy.$APPS_DOMAIN. The People tab invites the others: each
     gets a link to choose a password or a passkey. Only accounts you flag as
     administrators can reach the console.
  4. Give CI jobs and AI agents a deploy key (an app's panel in the dashboard),
     never the deploy token.
  5. Sign-in pages live at https://auth.$APPS_DOMAIN, with each person's
     account page (password, passkeys, access keys for scripts).
  6. To bring everything back after a power cut:
       sudo cp nanodeploy.service /etc/systemd/system/
       sudo systemctl daemon-reload && sudo systemctl enable nanodeploy
     Adjust WorkingDirectory and RequiresMountsFor inside the file first.
  7. Your deploy token is in .env as DEPLOY_TOKEN. It can do everything: keep
     it in your password manager, for emergencies.

TXT
