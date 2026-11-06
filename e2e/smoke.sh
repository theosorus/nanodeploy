#!/usr/bin/env bash
# Smoke test of Nanodeploy's critical path. Run it on the host (or anywhere the
# stack is reachable). Covers auth, the identity and cross-origin boundaries,
# deploying a cold app, post-deploy sleep, waking through sablier, the session
# cookie kept from apps, failed deploys, access kept across deploys, deploy
# keys, versions and rollback, image prune and reconcile.
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
roles: [moderator]
protect:
  - { path: /api/admin/*, role: moderator }
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
  else if (req.url === "/api/cookie") res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
  else { res.statusCode = 404; res.end(JSON.stringify({ error: "not found" })); }
}).listen(port);
EOF
echo "<h1>smoke</h1>" > "$WORK/demo/dist/index.html"
(cd "$WORK/demo" && zip -qr "$WORK/smoke.zip" .)

# same app with its backend missing: the image build fails
mkdir -p "$WORK/broken/dist"
cp "$WORK/demo/app.yaml" "$WORK/broken/app.yaml"
echo "<h1>broken</h1>" > "$WORK/broken/dist/index.html"
(cd "$WORK/broken" && zip -qr "$WORK/broken.zip" .)

# a bundle for another app, to check that a deploy key stays in its lane
mkdir -p "$WORK/other"
sed 's/^slug: smoke$/slug: smoke-other/' "$WORK/demo/app.yaml" > "$WORK/other/app.yaml"
cp "$WORK/demo/server.js" "$WORK/other/server.js"
(cd "$WORK/other" && zip -qr "$WORK/other.zip" .)

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
for _ in $(seq 1 15); do
  B=$(json -H "Host: smoke.$DOM" $BASE/api/ping)
  echo "$B" | grep -q '"ok":true' && break
  sleep 0.4
done
echo "$B" | grep -q '"ok":true' && ok "backend answers after sablier wake" || bad "no wake: $B"
check "$(docker inspect -f '{{.State.Status}}' app-smoke)" "running" "container running"

echo "== gate: public app with a protected back office =="
check "$(code -H "Host: smoke.$DOM" $BASE/api/admin/anything)" "401" "protected path asks an anonymous visitor to sign in"
L=$(curl -s -o /dev/null -w '%{redirect_url}' -H "Host: smoke.$DOM" -H 'Accept: text/html' $BASE/api/admin/anything)
echo "$L" | grep -q "auth.$DOM/login?to=" && ok "a browser is sent to the sign-in page" || bad "no sign-in redirect: $L"
json -H "Host: smoke.$DOM" $BASE/_nd/me | grep -q '"anonymous":true' && ok "/_nd/me on an app host" || bad "/_nd/me"
check "$(code -H "Host: smoke.$DOM" -H 'Cookie: nd_s=forged; __Host-nd_s=forged' $BASE/api/admin/x)" "401" "forged session cookie -> 401"
check "$(code -H "Host: smoke.$DOM" -H "Authorization: Bearer ndk_$(printf 'A%.0s' $(seq 43))" $BASE/api/admin/x)" \
  "401" "unknown access key -> 401"
check "$(code -H "Host: auth.$DOM" "$BASE/verify?app=smoke")" "404" "forward-auth endpoint not reachable from outside"
check "$(code -H "Host: auth.$DOM" $BASE/login)" "200" "sign-in page"

echo "== analytics =="
check "$(code -H "Host: smoke.$DOM" "$BASE/_nd/e?p=%2Fhello")" "204" "page-view beacon answered by caddy"
check "$(code -H "Host: deploy.$DOM" -H "$AUTH" "$BASE/api/apps/smoke/analytics?range=24h")" "200" "app analytics"
json -H "Host: deploy.$DOM" -H "$AUTH" $BASE/api/analytics | grep -q '"slug":"smoke"' && ok "analytics overview lists the app" \
  || bad "overview without the app"

echo "== platform cookie never reaches an app =="
# tinyauth's cookies live on the parent domain, so the browser sends them to
# every app: an app backend holding an admin's session could drive the console
C=$(json -H "Host: smoke.$DOM" -H 'Cookie: theme=dark; tinyauth-session-1a2b3c4d=SECRET; __Host-nd_s=S2; lang=fr' $BASE/api/cookie)
echo "$C" | grep -q '"cookie":"theme=dark; lang=fr"' && ok "platform cookies stripped, app cookies kept" \
  || bad "cookie reached the app: $C"

echo "== a failed deploy leaves the live version alone =="
R=$(json -X POST -H "Host: deploy.$DOM" -H "$AUTH" -F bundle=@$WORK/broken.zip $BASE/api/deploy)
echo "$R" | grep -q 'left untouched' && ok "broken bundle refused" || bad "broken bundle: $R"
check "$(json -H "Host: smoke.$DOM" $BASE/)" "<h1>smoke</h1>" "previous frontend still served"
json -H "Host: smoke.$DOM" $BASE/api/ping | grep -q '"ok":true' && ok "previous backend still answers" \
  || bad "backend gone after a failed deploy"

echo "== access set in the dashboard survives a redeploy =="
setaccess() {
  json -X POST -H "Host: deploy.$DOM" -H "$AUTH" -H 'content-type: application/json' \
    -d "{\"access\":\"$1\"}" "$BASE/api/apps/smoke/access" >/dev/null
}
setaccess private
R=$(json -X POST -H "Host: deploy.$DOM" -H "$AUTH" -F bundle=@$WORK/smoke.zip $BASE/api/deploy)
A=$(json -H "Host: deploy.$DOM" -H "$AUTH" $BASE/api/apps | grep -o '"slug":"smoke","name":"[^"]*","access":"[a-z]*"')
echo "$A" | grep -q '"access":"private"' && ok "still private after deploying access: public" || bad "access overwritten: $A"
echo "$R" | grep -q 'access kept as' && ok "deploy log says why" || bad "no access note: $R"
setaccess public

echo "== deploy keys =="
K=$(json -X POST -H "Host: deploy.$DOM" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"label":"smoke"}' $BASE/api/apps/smoke/keys | grep -o 'ndd_[A-Za-z0-9_-]*')
KEY="Authorization: Bearer $K"
[ ${#K} -eq 47 ] && ok "key created" || bad "no key: $K"
R=$(json -X POST -H "Host: deploy.$DOM" -H "$KEY" -F bundle=@$WORK/smoke.zip $BASE/api/deploy)
echo "$R" | grep -q '"ok":true' && ok "key deploys its own app, without a session" || bad "key deploy: $R"
check "$(code -H "Host: deploy.$DOM" -H "$KEY" $BASE/api/apps)" "403" "key cannot list apps"
check "$(code -H "Host: deploy.$DOM" -H "$KEY" -X DELETE $BASE/api/apps/smoke)" "403" "key cannot delete"
check "$(code -H "Host: deploy.$DOM" -H "$KEY" -X POST -F bundle=@$WORK/other.zip $BASE/api/deploy)" \
  "403" "key refused for another app"
FAKE="ndd_$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=' | cut -c1-43)"
check "$(code -H "Host: deploy.$DOM" -H "Authorization: Bearer $FAKE" $BASE/api/apps)" "401" "unknown key -> 401"
ID=$(json -H "Host: deploy.$DOM" -H "$AUTH" $BASE/api/apps/smoke/keys | grep -o '"id":"[0-9]*"' | head -1 | cut -d'"' -f4)
json -X DELETE -H "Host: deploy.$DOM" -H "$AUTH" "$BASE/api/apps/smoke/keys/$ID" >/dev/null
check "$(code -H "Host: deploy.$DOM" -H "$KEY" -X POST -F bundle=@$WORK/smoke.zip $BASE/api/deploy)" \
  "401" "revoked key -> 401"

echo "== versions and rollback =="
R=$(json -H "Host: deploy.$DOM" -H "$AUTH" $BASE/api/apps/smoke/releases)
PREV=$(echo "$R" | grep -o '"id":"[0-9]*","number":[0-9]*,"dir":[0-9]*,"source":"[a-z]*","message":"[^"]*","commitSha":[^,]*,"commitMessage":[^,]*,"status":"superseded"' | head -1 | grep -o '"id":"[0-9]*"' | cut -d'"' -f4)
[ -n "$PREV" ] && ok "earlier version listed" || bad "no superseded version: $R"
R=$(json -X POST -H "Host: deploy.$DOM" -H "$AUTH" -H 'content-type: application/json' -d '{}' \
  "$BASE/api/apps/smoke/releases/$PREV/rollback")
echo "$R" | grep -q '"ok":true' && ok "rollback to the previous version" || bad "rollback: $R"
check "$(json -H "Host: smoke.$DOM" $BASE/)" "<h1>smoke</h1>" "frontend served after the rollback"

echo "== prune and delete =="
for _ in 1 2 3 4; do
  curl -s -o /dev/null -X POST -H "Host: deploy.$DOM" -H "$AUTH" -F bundle=@$WORK/smoke.zip $BASE/api/deploy
done
N=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -c '^nanodeploy/smoke:')
[ "$N" -le 3 ] && ok "at most 3 images kept for instant rollbacks ($N)" || bad "$N images left after prune"

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
