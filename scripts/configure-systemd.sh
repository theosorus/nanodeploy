#!/usr/bin/env bash
# Render reviewable units in var/systemd. Installing them remains an explicit
# operator action; this script never writes to /etc or enables a timer.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

RUN_AS=${SUDO_USER:-$(id -un)}
if [ "${1:-}" = --help ]; then
  printf '%s\n' 'Usage: ./scripts/configure-systemd.sh [--user USER]' \
    'Generates var/systemd/ with your checkout, app storage and Docker paths.'
  exit 0
fi
if [ "$#" -gt 0 ]; then
  if [ "$#" -ne 2 ] || [ "$1" != --user ]; then
    printf '%s\n' 'Usage: ./scripts/configure-systemd.sh [--user USER]' >&2
    exit 1
  fi
  RUN_AS=$2
fi
[ -f .env ] || { printf '%s\n' 'Run ./install.sh --init first.' >&2; exit 1; }
command -v python3 >/dev/null || { printf '%s\n' 'python3 is required.' >&2; exit 1; }
id "$RUN_AS" >/dev/null 2>&1 || { printf 'Unknown user: %s\n' "$RUN_AS" >&2; exit 1; }
# shellcheck disable=SC1091
. ./.env
: "${APPS_DIR:?Set APPS_DIR in .env first}"
DOCKER_BIN=$(command -v docker)
DOCKER_ROOT=$(docker info --format '{{.DockerRootDir}}')
python3 - "$PWD" "$APPS_DIR" "$RUN_AS" "$DOCKER_BIN" "$DOCKER_ROOT" <<'PY'
import pathlib, re, sys

root, apps, user, docker, docker_root = sys.argv[1:]
if not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_.-]*[$]?', user):
    raise SystemExit('Use a local system account for the services.')

def quoted(value):
    if not value.startswith('/') or any(c in value for c in '\n\r\x00'):
        raise SystemExit('Service paths must be absolute, without newlines.')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'

directory = pathlib.Path(root)
output = directory / 'var/systemd'
output.mkdir(parents=True, exist_ok=True)
for name in ('nanodeploy.service', 'nanodeploy-update.service'):
    lines = []
    for line in (directory / name).read_text().splitlines():
        if line.startswith('WorkingDirectory='):
            line = 'WorkingDirectory=' + quoted(root)
        elif line.startswith('RequiresMountsFor='):
            line = 'RequiresMountsFor=' + ' '.join(quoted(p) for p in dict.fromkeys((root, apps, docker_root)))
        elif line.startswith('ExecStart='):
            line = ('ExecStart=' + quoted(root + '/scripts/update.sh') if name == 'nanodeploy-update.service'
                    else 'ExecStart=' + quoted(docker) + ' compose up -d')
        elif line.startswith('ExecStop='):
            line = 'ExecStop=' + quoted(docker) + ' compose stop'
        elif line.startswith('User='):
            continue
        lines.append(line)
        if line == '[Service]':
            lines.append('User=' + user)
    (output / name).write_text('\n'.join(lines) + '\n')
(output / 'nanodeploy-update.timer').write_text((directory / 'nanodeploy-update.timer').read_text())
print('Generated var/systemd/ for user ' + user + '.')
print('Review the files, then follow docs/INSTALL.md#start-on-boot.')
PY
