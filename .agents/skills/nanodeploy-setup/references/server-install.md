# Server installation

## Contents
- Before starting: what the user must have
- 1. Prepare the machine
- 2. Clone and initialise
- 3. Configure .env
- 4. Check and start
- 5. DNS and HTTPS
- 6. Trust the real proxy address
- 7. Create the administrator
- 8. Prove it works
- 9. Start on boot and first backup

Copy this checklist into your reply and tick it as you go:

```
- [ ] 1. Machine ready: Linux 64-bit, Docker 28+, Compose v2, git, openssl
- [ ] 2. Repository cloned, ./install.sh --init done
- [ ] 3. .env: APPS_DOMAIN, PUBLIC_SCHEME, COOKIE_SECURE, TIMEZONE, APPS_DIR
- [ ] 4. ./install.sh --check passes, ./install.sh done, services running
- [ ] 5. Wildcard DNS and HTTPS reach 127.0.0.1:8080 with the Host kept
- [ ] 6. TRUSTED_PROXY_CIDRS set to the proxy address Caddy sees
- [ ] 7. Administrator account created from the SETUP link
- [ ] 8. A test app deploys, opens, sleeps and wakes up
- [ ] 9. systemd unit installed, first backup taken and copied off the machine
```

## Before starting: what the user must have

- A 64-bit Linux machine (x86-64 or ARM64): VPS, mini PC or ARM board. Plan
  4 GB of RAM and 20 GB of SSD; more for Git builds or many apps.
- A domain they control, with a dedicated level for apps, e.g.
  `apps.example.com`. Apps become `<slug>.apps.example.com`, the console
  `deploy.apps.example.com`, accounts `auth.apps.example.com`.
- A way for HTTPS to reach the machine: their own reverse proxy with a
  wildcard certificate, or a tunnel (Cloudflare Tunnel or similar). No inbound
  port is needed with a tunnel.

## 1. Prepare the machine

Install Docker Engine 28+ and the Compose plugin from Docker's official
instructions for the distribution, then the tools (Debian/Ubuntu):

```bash
sudo apt-get update
sudo apt-get install git openssl python3 curl util-linux
docker info --format '{{.ServerVersion}}'    # 28 or newer
docker compose version                       # v2
```

Run everything as the user who will own the checkout and can run `docker
info` (in the `docker` group: log out and in again after adding it). Rootless
Docker, Podman, Swarm and remote Docker daemons are not supported. Very old
board images with an obsolete kernel may not run Node 24 images.

## 2. Clone and initialise

```bash
git clone https://github.com/theosorus/nanodeploy.git
cd nanodeploy
./install.sh --init
```

`--init` creates `.env` and fills every empty secret (`POSTGRES_PASSWORD`,
`DEPLOY_TOKEN`, `GATE_DB_PASSWORD`, `NANODEPLOY_SECRET_KEY`). It needs no
Docker and never overwrites a secret that is already set.

## 3. Configure .env

Edit these lines (keep `NAME=value`, no spaces around `=`):

```dotenv
APPS_DOMAIN=apps.example.com     # hostname only: no https://, no *, no port, no path
PUBLIC_SCHEME=https
COOKIE_SECURE=true
TIMEZONE=Europe/Paris            # the user's zone; analytics days start at its midnight
```

`APPS_DIR` (where releases and app files live) defaults to `var/apps` inside
the checkout, which is fine. For another disk, create it owned by the
checkout user, then set the absolute path:

```bash
sudo install -d -m 755 -o "$(id -un)" -g "$(id -gn)" /srv/nanodeploy/apps
# .env: APPS_DIR=/srv/nanodeploy/apps
```

Never move `APPS_DIR` after apps exist without a backup and a plan.

## 4. Check and start

```bash
./install.sh --check
./install.sh
docker compose ps
```

`--check` changes nothing; fix everything it reports first. The install
builds images (Caddy is compiled, several minutes), creates networks and
starts the services. A short restart of gate on the first boot is normal.

## 5. DNS and HTTPS

The platform listens on **`http://127.0.0.1:8080`** only. Two separate things
must be true:

1. **DNS**: `*.apps.example.com` resolves to the server or the tunnel. A
   wildcard record, not one record per app.
2. **HTTPS routing**: every `*.apps.example.com` request reaches
   `http://127.0.0.1:8080` with its **original `Host` header** and
   `X-Forwarded-Proto: https`. The certificate covers `*.apps.example.com`.
   A certificate for `*.example.com` does **not** cover
   `deploy.apps.example.com`.

**Option A, the user's own reverse proxy** (Nginx, Caddy, Traefik on the
host): a wildcard certificate needs a DNS-01 ACME challenge. In the
repository, `examples/nginx.conf` is a complete Nginx example: copy it,
replace the domain and certificate paths, then `sudo nginx -t` before
reloading. Expose 443 (and 80 for redirects). A proxy running in a container
cannot reach the host's `127.0.0.1` with its own `localhost`: run it on the
host or use host networking.

**Option B, a tunnel** (no open router port): route the hostname
`*.apps.example.com` to `http://127.0.0.1:8080` **and** create the wildcard
DNS record pointing to the tunnel. Do not set a fixed "HTTP Host Header" in
the tunnel. With Cloudflare, the default edge certificate covers
`*.example.com` only; a second level like `*.apps.example.com` needs an
advanced certificate, or use a first-level name for `APPS_DOMAIN`.

Check from any machine:

```bash
nslookup deploy.apps.example.com
curl -sI https://deploy.apps.example.com | head -n 1     # an HTTP status, no TLS error
```

The bare `apps.example.com` has no page; a 404 there is normal.

## 6. Trust the real proxy address

Caddy only believes visitor-IP headers from addresses in
`TRUSTED_PROXY_CIDRS`. With a wrong value, rate limits treat every visitor as
one. After one request has gone through the proxy:

```bash
docker compose exec caddy tail -n 5 /var/log/caddy/apps.log      # look at remote_ip
docker network inspect nanodeploy_edge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

Add exactly that address as a `/32` to `.env`, keeping the loopback entries,
then recreate Caddy:

```bash
# .env: TRUSTED_PROXY_CIDRS="127.0.0.1/32 ::1/128 172.18.0.1/32"
docker compose up -d caddy
```

Never trust a whole private range: app containers use private addresses too.

## 7. Create the administrator

Once HTTPS works:

```bash
docker compose logs control-plane | grep -A1 SETUP
```

The user opens the full link (a one-time secret), chooses a username and a
password, then can add a passkey on `https://auth.apps.example.com`. Then
`https://deploy.apps.example.com` opens the console; it asks them to confirm
their sign-in. Invite other people from **People & access**: Nanodeploy sends
no email, the user hands each invitation link over.

## 8. Prove it works

Deploy the template app (nanodeploy-app skill, or the steps in
[local-trial.md](local-trial.md) with the real console URL). Then check:

- `https://my-app.apps.example.com` opens after sign-in and saves a note;
- after `docker stop app-my-app`, a reload wakes it and the note is there;
- the console's app panel shows it asleep after `idle.timeout`.

## 9. Start on boot and first backup

With systemd:

```bash
./scripts/configure-systemd.sh
cat var/systemd/nanodeploy.service        # read the paths and User it chose
sudo cp var/systemd/nanodeploy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nanodeploy.service
```

It reconciles stopped apps and routes after a reboot. Then take a first
backup and copy it off the machine (see [operations.md](operations.md)).
Automatic updates are optional and off by default: same file.
