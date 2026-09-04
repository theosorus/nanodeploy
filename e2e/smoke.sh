#!/usr/bin/env bash
# Smoke test of Nanodeploy's critical path. Run it on the host (or anywhere the
# stack is reachable). Covers auth, the identity and cross-origin boundaries,
# deploying a cold app, post-deploy sleep, waking through sablier, image prune
# and reconcile.
#
# Variables (defaults suit a local install):
#   NANODEPLOY_BASE   http://127.0.0.1:8080
#   NANODEPLOY_TOKEN  the DEPLOY_TOKEN from .env
#   APPS_DOMAIN       the domain the stack serves
set -u

BASE="${NANODEPLOY_BASE:-http://127.0.0.1:8080}"
TOK="${NANODEPLOY_TOKEN:-}"
DOM="${APPS_DOMAIN:-apps.test}"
if [ -z "$TOK" ]; then
  echo "set NANODEPLOY_TOKEN (the DEPLOY_TOKEN from .env)"; exit 1
fi
AUTH="Authorization: Bearer $TOK"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
check(){ if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got [$1] want [$2])"; fi; }
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
json() { curl -s "$@"; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/demo/dist"

cat > "$WORK/demo/app.yaml" <<EOF
name: Smoke
slug: smoke
access: public
frontend: true
backend:
  entry: server.js
  port: 3000
database:
  enabled: false
idle:
  timeout: 10m
  warm: false
env: []
EOF

cat > "$WORK/demo/server.js" <<'EOF'
const http = require("http");
const port = Number(process.env.PORT ?? 3000);
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/ping") res.end(JSON.stringify({ ok: true, pid: process.pid }));
  else { res.statusCode = 404; res.end(JSON.stringify({ error: "not found" })); }
}).listen(port);
EOF
echo "<h1>smoke</h1>" > "$WORK/demo/dist/index.html"
(cd "$WORK/demo" && zip -qr "$WORK/smoke.zip" .)

mkdir -p "$WORK/reserved"
sed 's/^slug: smoke$/slug: deploy/' "$WORK/demo/app.yaml" > "$WORK/reserved/app.yaml"
cp "$WORK/demo/server.js" "$WORK/reserved/server.js"
(cd "$WORK/reserved" && zip -qr "$WORK/reserved.zip" .)

echo "== auth =="
check "$(code -H "Host: deploy.$DOM" $BASE/api/apps)" "401" "no session -> 401"
check "$(code -H "Host: deploy.$DOM" -H 'Authorization: Bearer bogus' $BASE/api/apps)" "401" "bogus bearer -> 401"
check "$(code -H "Host: deploy.$DOM" -H "$AUTH" $BASE/api/apps)" "200" "exact token -> 200"

echo "== boundaries =="
# the gateway owns the identity headers: a client must never be able to send one
check "$(code -H "Host: deploy.$DOM" -H 'Remote-Sub: forged' $BASE/api/apps)" \
  "401" "forged Remote-Sub -> 401"
check "$(code -H "Host: deploy.$DOM" -H 'Remote-Sub: forged' -H 'Remote-Groups: admins' $BASE/api/apps)" \
  "401" "forged Remote-Groups -> 401"
# The cross-origin guard only matters for a request that already carries a
# session, which caddy would never let through unauthenticated. Talk to the
# control plane directly, injecting the identity headers forward-auth produces.
direct() {
  docker exec nanodeploy-control-plane-1 node -e '
    const [method, path, headers] = process.argv.slice(1);
    fetch("http://127.0.0.1:8000" + path, { method, headers: JSON.parse(headers) })
      .then((r) => console.log(r.status))
      .catch(() => console.log("ERR"));
  ' "$1" "$2" "$3" 2>/dev/null
}
# multipart is a CORS simple request: without this guard, any web page an admin
# visits could deploy code here using their cookie
check "$(direct POST /api/reconcile '{"Remote-Sub":"u1","Sec-Fetch-Site":"cross-site"}')" \
  "403" "session + cross-site request -> 403"
check "$(direct POST /api/reconcile '{"Remote-Sub":"u1","Origin":"https://evil.example"}')" \
  "403" "session + foreign origin -> 403"
S=$(direct POST /api/reconcile '{"Remote-Sub":"u1","Sec-Fetch-Site":"same-origin"}')
if [ "$S" != "403" ]; then ok "same-origin session not blocked"; else bad "same-origin wrongly blocked"; fi
# a slug that collides with a platform host makes every later caddy reload fail
R=$(json -X POST -H "Host: deploy.$DOM" -H "$AUTH" -F bundle=@$WORK/reserved.zip $BASE/api/deploy)
echo "$R" | grep -q 'reserved' && ok "reserved slug refused" || bad "reserved slug accepted: $R"
curl -s -D- -o /dev/null -H "Host: deploy.$DOM" -H "$AUTH" $BASE/ | grep -qi '^x-frame-options: DENY' \
  && ok "console cannot be framed" || bad "X-Frame-Options header missing"

echo "== deploy and sleep =="
R=$(json -s -X POST -H "Host: deploy.$DOM" -H "$AUTH" -F bundle=@$WORK/smoke.zip $BASE/api/deploy)
echo "$R" | grep -q '"ok":true' && ok "deploy smoke" || bad "deploy smoke: $R"
check "$(docker inspect -f '{{.State.Status}}' app-smoke)" "exited" "cold app asleep after deploy"
check "$(code -H "Host: smoke.$DOM" $BASE/)" "200" "static files served by caddy"

echo "== wake on request =="
docker stop -t 1 app-smoke >/dev/null 2>&1
B=""
for i in $(seq 1 15); do
  B=$(json -H "Host: smoke.$DOM" $BASE/api/ping)
  echo "$B" | grep -q '"ok":true' && break
  sleep 0.4
done
echo "$B" | grep -q '"ok":true' && ok "backend answers after sablier wake" || bad "no wake: $B"
check "$(docker inspect -f '{{.State.Status}}' app-smoke)" "running" "container running"

echo "== prune and delete =="
for i in 1 2; do
  curl -s -o /dev/null -X POST -H "Host: deploy.$DOM" -H "$AUTH" -F bundle=@$WORK/smoke.zip $BASE/api/deploy
done
N=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -c '^nanodeploy/smoke:')
check "$N" "1" "one image left after 3 deploys (prune)"

docker rm -f app-smoke >/dev/null 2>&1
docker images --format '{{.Repository}}:{{.Tag}}' | grep '^nanodeploy/smoke:' | xargs -I{} docker rmi {} >/dev/null 2>&1
json -X POST -H "Host: deploy.$DOM" -H "$AUTH" $BASE/api/reconcile >/dev/null
sleep 2
[ "$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -c '^nanodeploy/smoke:')" -ge 1 ] \
  && ok "image rebuilt by reconcile" || bad "image not rebuilt"
check "$(docker inspect -f '{{.State.Status}}' app-smoke)" "exited" "container recreated and asleep"

check "$(code -H "Host: deploy.$DOM" -H "$AUTH" -X DELETE $BASE/api/apps/smoke)" "200" "delete"
check "$(code -H "Host: smoke.$DOM" $BASE/)" "404" "unknown subdomain -> 404"

echo
echo "== RESULT: $PASS passed / $FAIL failed =="
exit $FAIL
