#!/usr/bin/env bash
# Continuous delivery for the platform itself, pulled by the server: no port to
# open, no secret in GitHub, nothing a pull request from a stranger can run.
# A systemd timer (nanodeploy-update.timer) calls this every few minutes:
#
#  1. fetch the tracked branch; nothing new, nothing to do;
#  2. wait until every CI check of that commit has passed (a red commit is
#     never deployed, and is not retried);
#  3. back up everything (scripts/backup.sh);
#  4. fast-forward and run ./install.sh (secrets, networks, images, restart);
#  5. check the console answers and still lists at least as many apps;
#     otherwise go back to the previous commit and restart it.
set -euo pipefail
cd "$(dirname "$0")/.."
exec 9>"${TMPDIR:-/tmp}/nanodeploy-update.lock"
flock -n 9 || exit 0
set -a
# shellcheck disable=SC1091
. ./.env
set +a

BRANCH=${UPDATE_BRANCH:-main}
GITHUB_API=${GITHUB_API_URL:-https://api.github.com}
HEALTH_TRIES=${UPDATE_HEALTH_TRIES:-60}
FAILED_MARK=.update-failed
say() { printf '[update] %s\n' "$1"; }
apps_count() {
  curl -fsS --max-time 20 -H "Host: deploy.$APPS_DOMAIN" -H "Authorization: Bearer $DEPLOY_TOKEN" \
    "http://127.0.0.1:${CADDY_PORT:-8080}/api/apps" |
    python3 -c 'import json,sys; print(len(json.load(sys.stdin)["apps"]))'
}

git fetch -q origin "$BRANCH"
current=$(git rev-parse HEAD)
next=$(git rev-parse "origin/$BRANCH")
[ "$current" = "$next" ] && exit 0
if [ "$(cat "$FAILED_MARK" 2>/dev/null)" = "$next" ]; then
  exit 0 # already tried and rolled back; the next push gets its own chance
fi
if ! git merge-base --is-ancestor "$current" "$next"; then
  say "local history is not behind origin/$BRANCH: refusing to touch it"
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  say "uncommitted changes in $(pwd): refusing to update over them"
  exit 1
fi

repo=$(git remote get-url origin | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')
checks=$(curl -fsS --max-time 20 "$GITHUB_API/repos/$repo/commits/$next/check-runs?per_page=100") || {
  say "github did not answer, trying again later"
  exit 0
}
verdict=$(printf '%s' "$checks" | python3 -c '
import json, sys
runs = json.load(sys.stdin).get("check_runs", [])
if not runs: print("pending")
elif any(r["status"] != "completed" for r in runs): print("pending")
elif all(r["conclusion"] in ("success", "skipped", "neutral") for r in runs): print("green")
else: print("red")')
case "$verdict" in
  pending) exit 0 ;;
  red)
    say "CI failed on ${next:0:7}: not deploying it"
    echo "$next" >"$FAILED_MARK"
    exit 1
    ;;
esac

before=$(apps_count || echo 0)
say "${current:0:7} -> ${next:0:7}, $before app(s) before"
./scripts/backup.sh

rollback() {
  say "rolling back to ${current:0:7}"
  echo "$next" >"$FAILED_MARK"
  git reset -q --hard "$current"
  ./install.sh || say "the rollback did not start cleanly either: see 'docker compose ps' and the latest backup"
  exit 1
}

git merge -q --ff-only "$next"
./install.sh || rollback

# the control plane reconciles every app at start: give it time
for _ in $(seq 1 "$HEALTH_TRIES"); do
  after=$(apps_count 2>/dev/null || echo "")
  if [ -n "$after" ] && [ "$after" -ge "$before" ]; then
    rm -f "$FAILED_MARK"
    say "now at ${next:0:7}, $after app(s)"
    exit 0
  fi
  sleep 5
done
say "the console did not come back with $before app(s)"
rollback
