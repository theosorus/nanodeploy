#!/usr/bin/env bash
# Run on the Docker host. Configuration and data stay outside version control.
set -euo pipefail
umask 077
cd "$(dirname "${BASH_SOURCE[0]}")"

INIT_ONLY=false
LOCAL=false
CHECK_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --init) INIT_ONLY=true ;;
    --local) LOCAL=true ;;
    --check) CHECK_ONLY=true ;;
    --help|-h)
      cat <<'TXT'
Usage: ./install.sh [--init] [--local] [--check]

  --init   Generate .env and missing secrets, then exit. Docker is not needed.
  --local  Set up a fresh local trial at http://deploy.apps.localhost:8080.
           An existing configuration is never switched to local mode.
  --check  Validate configuration and Docker without changing files or services.
  --help   Show this help.

Without options, the first run creates .env; edit APPS_DOMAIN and run again.
See docs/INSTALL.md (English) or docs/INSTALL.fr.md (French).
TXT
      exit 0 ;;
    *) printf 'Unknown option: %s\nRun ./install.sh --help\n' "$arg" >&2; exit 1 ;;
  esac
done
if "$CHECK_ONLY" && { "$INIT_ONLY" || "$LOCAL"; }; then
  printf '%s\n' '--check cannot be combined with --init or --local' >&2
  exit 1
fi

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$1"; }
ok() { printf '  \033[32mok\033[0m %s\n' "$1"; }
die() { printf '\n  \033[31mx %s\033[0m\n\n' "$1" >&2; exit 1; }

say "1/5 preparing configuration"
source_env() { set -a; . ./.env; set +a; }

# sed -i is not portable (GNU wants no argument, BSD wants one): rewrite the
# file instead, so the installer also works when run from a mac
set_var() {
  local tmp
  tmp=$(mktemp .env.XXXXXX)
  NANODEPLOY_ENV_KEY=$1 NANODEPLOY_ENV_VALUE=$2 awk '
    BEGIN { k=ENVIRON["NANODEPLOY_ENV_KEY"]; v=ENVIRON["NANODEPLOY_ENV_VALUE"] }
    { if (index($0, k "=") == 1) print k "=" v; else print }
  ' .env >"$tmp"
  mv "$tmp" .env
}

NEW_ENV=false
if [ ! -f .env ]; then
  "$CHECK_ONLY" && die "no .env found; run ./install.sh --init first"
  # A checkout-owned directory works without sudo and is already gitignored.
  # Single quotes keep spaces and dollar signs literal in Bash and Compose.
  case "$PWD" in *"'"*|*$'\n'*|*$'\r'*) die "checkout path cannot contain a single quote or newline; copy .env.example to .env and set APPS_DIR manually";; esac
  cp .env.example .env
  NEW_ENV=true
  set_var APPS_DIR "'$PWD/var/apps'"
  if "$LOCAL"; then
    set_var APPS_DOMAIN apps.localhost
    set_var PUBLIC_SCHEME http
    set_var PUBLIC_PORT 8080
    set_var COOKIE_SECURE false
  fi
fi

# Loading first also recognizes quoted empty values in a copied .env.example.
source_env
if ! "$CHECK_ONLY"; then
  command -v openssl >/dev/null || die "openssl is required to generate secrets"
  for secret in POSTGRES_PASSWORD DEPLOY_TOKEN GATE_DB_PASSWORD NANODEPLOY_SECRET_KEY; do
    value=${!secret:-}
    if [ -z "$value" ]; then
      bytes=24
      [ "$secret" != NANODEPLOY_SECRET_KEY ] || bytes=32
      grep -q "^$secret=" .env || printf '\n%s=\n' "$secret" >> .env
      set_var "$secret" "$(openssl rand -hex "$bytes")"
      ok "generated $secret"
    fi
  done
  chmod 600 .env
  source_env
fi

if "$LOCAL" && [ "${APPS_DOMAIN:-}" != apps.localhost ]; then
  die "--local cannot change an existing installation; use a separate checkout and Docker host for a local trial"
fi
if "$INIT_ONLY" || { "$NEW_ENV" && ! "$LOCAL"; }; then
  ok "configuration ready in .env (existing secrets preserved)"
  warn "set APPS_DOMAIN in .env, review APPS_DIR, then run ./install.sh"
  exit 0
fi

# Old .env files otherwise keep pinning the vulnerable gateway on upgrades.
if ! awk -v version="${CADDY_VERSION:-0}" 'BEGIN {
  n=split(version,v,"."); exit !(n==3 && (v[1]>2 || (v[1]==2 && (v[2]>11 || (v[2]==11 && v[3]>=9)))))
}'; then
  "$CHECK_ONLY" && die "CADDY_VERSION must be 2.11.9 or newer; run ./install.sh to upgrade the pin"
  grep -q '^CADDY_VERSION=' .env || printf '\nCADDY_VERSION=\n' >> .env
  set_var CADDY_VERSION 2.11.9
  export CADDY_VERSION=2.11.9
  ok "upgraded Caddy to the security minimum 2.11.9"
fi

# every one of these has cost someone an evening of debugging
[ -n "${APPS_DOMAIN:-}" ] || die "APPS_DOMAIN is empty in .env"
[ "$APPS_DOMAIN" != "apps.example.com" ] || die "APPS_DOMAIN is still the example value, set your own domain in .env"
[[ "$APPS_DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "APPS_DOMAIN must be a lowercase domain without a scheme, port, wildcard or path"
[ "${#APPS_DOMAIN}" -le 253 ] || die "APPS_DOMAIN is too long"
IFS=. read -r -a labels <<< "$APPS_DOMAIN"
for label in "${labels[@]}"; do
  [ "${#label}" -le 63 ] || die "APPS_DOMAIN contains a label longer than 63 characters"
done
[ -n "${APPS_DIR:-}" ] || die "APPS_DIR is empty in .env"
case "$APPS_DIR" in /*) ;; *) die "APPS_DIR must be an absolute path, got '$APPS_DIR'";; esac
for secret in POSTGRES_PASSWORD DEPLOY_TOKEN GATE_DB_PASSWORD NANODEPLOY_SECRET_KEY; do
  value=${!secret:-}
  [ -n "$value" ] || die "$secret is empty in .env; run ./install.sh --init to fill missing secrets"
done
[[ "$NANODEPLOY_SECRET_KEY" =~ ^[0-9a-fA-F]{64}$ ]] || die "NANODEPLOY_SECRET_KEY must contain exactly 64 hexadecimal characters; preserve an existing encryption key"
[[ "$DEPLOY_TOKEN" =~ ^[A-Za-z0-9_-]{24,128}$ ]] || die "DEPLOY_TOKEN must be 24–128 letters, digits, underscores or hyphens"
for secret in POSTGRES_PASSWORD GATE_DB_PASSWORD; do
  [[ "${!secret}" =~ ^[A-Za-z0-9_-]+$ ]] || die "$secret must be URL-safe (letters, digits, underscores or hyphens); do not change an existing database password without rotating it in Postgres"
done
PUBLIC_SCHEME=${PUBLIC_SCHEME:-https}
PUBLIC_PORT=${PUBLIC_PORT:-}
COOKIE_SECURE=${COOKIE_SECURE:-true}
CADDY_PORT=${CADDY_PORT:-8080}
case "$PUBLIC_SCHEME" in https|http) ;; *) die "PUBLIC_SCHEME must be https or http";; esac
case "$COOKIE_SECURE" in true|false) ;; *) die "COOKIE_SECURE must be true or false";; esac
if [ "$PUBLIC_SCHEME" = https ]; then
  [ "$COOKIE_SECURE" = true ] || die "HTTPS requires COOKIE_SECURE=true"
else
  [ "$COOKIE_SECURE" = false ] || die "HTTP trials require COOKIE_SECURE=false; use HTTPS for a public installation"
  warn "plain HTTP trial: password sign-in only, keep this installation on localhost"
fi
for port in "$CADDY_PORT" "${PUBLIC_PORT:-443}"; do
  [[ "$port" =~ ^[0-9]{1,5}$ ]] && [ "$((10#$port))" -ge 1 ] && [ "$((10#$port))" -le 65535 ] || die "ports must be numbers between 1 and 65535"
done
ok "configuration looks sane"

say "2/5 checking Docker and preparing directories"
command -v docker >/dev/null || die "Docker is required; see docs/INSTALL.md#requirements"
docker compose version >/dev/null || die "Docker Compose v2 is required"
docker info >/dev/null 2>&1 || die "cannot reach Docker; start the daemon and check your user's Docker permissions"
if [ -n "${DOCKER_CONTEXT:-}" ]; then
  docker_endpoint=$(docker context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}')
else
  docker_endpoint=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}
fi
case "$docker_endpoint" in
  unix://*) ;;
  *) die "run the installer on the Docker host using its local Unix socket; remote TCP/SSH daemons are not supported" ;;
esac
if docker info --format '{{json .SecurityOptions}}' | grep -q rootless; then
  die "rootless Docker is not supported; use a local rootful Docker engine"
fi
engine=$(docker version --format '{{.Server.Version}}')
[[ "$engine" =~ ^([0-9]+)\. ]] && [ "${BASH_REMATCH[1]}" -ge 28 ] || die "Docker Engine 28 or newer is required; use a currently patched release"
[ "$(docker info --format '{{.OSType}}')" = linux ] || die "Docker must run Linux containers"
case "$(docker info --format '{{.Architecture}}')" in
  x86_64|amd64|aarch64|arm64) ;;
  *) die "a 64-bit x86 or ARM Docker host is required" ;;
esac
docker compose config --quiet
ok "Docker $engine and Compose available"
if "$CHECK_ONLY"; then
  ok "checks passed; no files or services changed"
  exit 0
fi

mkdir -p "$APPS_DIR"
chmod 755 "$APPS_DIR"
mkdir -p "$APPS_DIR/.snapshots" "$APPS_DIR/.builds" "$APPS_DIR/.staging"
ensure_network() {
  local network=$1 internal=$2
  if ! docker network inspect "$network" >/dev/null 2>&1; then
    if [ "$internal" = true ]; then
      docker network create --internal "$network" >/dev/null
    else
      docker network create "$network" >/dev/null
    fi
  fi
  [ "$(docker network inspect -f '{{.Internal}}' "$network")" = "$internal" ] || die "$network has incompatible isolation settings"
  ok "network $network"
}
for net in edge apps egress console; do ensure_network "nanodeploy_$net" false; done
for net in data wake docker sablier_control gate_data legacy; do ensure_network "nanodeploy_$net" true; done
if ! docker network inspect nanodeploy_build_secure >/dev/null 2>&1; then
  docker network create --internal --opt com.docker.network.bridge.inhibit_ipv4=true nanodeploy_build_secure >/dev/null
fi
[ "$(docker network inspect -f '{{.Internal}}' nanodeploy_build_secure)" = true ] || die "nanodeploy_build_secure must be internal"
[ "$(docker network inspect -f '{{index .Options "com.docker.network.bridge.inhibit_ipv4"}}' nanodeploy_build_secure)" = true ] || die "nanodeploy_build_secure must not expose a host gateway"
ok "apps dir $APPS_DIR"

say "3/5 building the gateway and platform images"
docker compose pull --ignore-buildable
warn "the first Caddy build compiles Go sources and can take several minutes"
docker compose build --pull

say "4/5 starting the platform"
# Upgrading from Pocket ID: it must answer while the control plane imports the
# accounts with their ids. Started here only while a key is configured; clear
# POCKETID_API_KEY in .env once everyone has signed in to stop it for good.
if [ -n "${POCKETID_API_KEY:-}" ]; then
  docker compose --profile legacy up -d pocket-id
  ok "pocket-id running for the account import"
fi
docker compose up -d
ok "containers up"

say "5/5 next steps"
PORT=$CADDY_PORT
ORIGIN="$PUBLIC_SCHEME://deploy.$APPS_DOMAIN${PUBLIC_PORT:+:$PUBLIC_PORT}"
if [ "$PUBLIC_SCHEME" = http ]; then
  cat <<TXT

  Open $ORIGIN after creating your administrator account with the
  one-time SETUP link below. Modern browsers resolve *.localhost to loopback.
  If needed, see docs/INSTALL.md#local-trial.

TXT
else
  cat <<TXT

  Point your HTTPS reverse proxy or tunnel at http://127.0.0.1:$PORT.
  DNS and TLS must cover *.$APPS_DOMAIN (including auth and deploy).
  Preserve the Host header and set TRUSTED_PROXY_CIDRS for your actual proxy.
  See docs/INSTALL.md#https-and-dns for complete proxy examples.

TXT
fi
cat <<TXT

  Create your administrator account using the one-time link in the logs:
       docker compose logs control-plane | grep -A1 SETUP

  Console: $ORIGIN
  Invite people and create per-app deploy keys from the console.
  Keep .env and its encryption key backed up; never give DEPLOY_TOKEN to apps.

  On a Linux server, generate boot/update units for your paths and user:
       ./scripts/configure-systemd.sh
  Follow docs/INSTALL.md#start-on-boot before installing them.

  Upgrading an existing installation? Read docs/UPGRADING.md first.

TXT
