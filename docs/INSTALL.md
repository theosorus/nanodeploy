# Install Nanodeploy

[Français](INSTALL.fr.md) · [Project overview](../README.md) · [Upgrading an existing server](UPGRADING.md)

Nanodeploy runs on your own Linux machine or VPS. It has no dependency on the
maintainer's server, domain, account, cloud provider or hardware. The source and
documentation are [MIT licensed](../LICENSE); bundled fonts retain their
[OFL license](../control-plane/public/fonts/SpaceGrotesk-OFL.txt).

Choose a [local trial](#local-trial) to try the complete platform without a
domain, or follow [server installation](#server-installation) for HTTPS hosting.
Already running Nanodeploy? Read [UPGRADING.md](UPGRADING.md) before updating.

## Requirements

| Requirement | Details |
| --- | --- |
| Server | 64-bit Linux, **x86-64 or ARM64**. A VPS, mini PC or ARM board works; no GPU needed. |
| Docker | A local, rootful **Docker Engine 28+**, on a currently patched release, with **Compose v2**. Use Linux containers. Rootless Docker, Podman, Swarm and remote Docker daemons are not supported by this installer. |
| Resources | Plan for **4 GB RAM** and **20 GB SSD storage**; Git builds may need more. Actual usage depends on your apps. Docker images, release files, databases and backups all consume space. |
| Server tools | Git, Bash, OpenSSL. Python 3, curl and `flock` are also needed for optional automatic updates; the backup script needs Linux tools and Bash 4+. |
| Public hosting | A domain you control, wildcard DNS, and a reverse proxy or tunnel that provides HTTPS. Any provider works. |
| App development | **Node.js 24**, npm and `zip` on your development machine. Node is included in the platform images; it is not required on the server. |

Install Docker using the [official Engine instructions](https://docs.docker.com/engine/install/)
and [Compose plugin instructions](https://docs.docker.com/compose/install/linux/).
On Debian/Ubuntu, the remaining server tools are available with:

```bash
sudo apt-get update
sudo apt-get install git openssl python3 curl util-linux
docker info
docker compose version
```

Run the installer as the user who owns the checkout and can run `docker info`.
If you use the Docker group, follow Docker's [Linux post-installation instructions](https://docs.docker.com/engine/install/linux-postinstall/)
and log in again after joining it. Access to Docker gives host administrator
power. Docker Desktop with Linux containers can be used for a local trial on
macOS or Windows/WSL2; production instructions below target Linux.

Use a modern Linux kernel and keep Docker and the OS patched. An old board
image with an obsolete kernel or seccomp library may not run Node 24 images.
Store Docker's data and app files on persistent storage. `/var/lib/docker` on
an SSD is fine; a separate mount is optional.
The first installation needs internet access to container/package registries
and the Go module sources used to build Caddy.

Only one Nanodeploy installation can use a given Docker daemon: container,
volume and network names are shared. A local trial on your laptop can coexist
with a production server using a separate daemon.

## Local trial

```bash
git clone https://github.com/theosorus/nanodeploy.git
cd nanodeploy
./install.sh --local
```

This creates a private `.env` with random secrets, stores app bundles in
`var/apps`, builds the images and starts the services. The first build compiles
Caddy and can take several minutes. It does not require Node on the host.
The command can be run again; existing secrets and data are preserved.

Find your one-time administrator link:

```bash
docker compose logs control-plane | grep -A1 SETUP
```

Open that link, choose your username and password, then open
**<http://deploy.apps.localhost:8080>**. Accounts live at
<http://auth.apps.localhost:8080>. Modern browsers resolve `*.localhost` to the
local machine. If yours does not, add these lines to your hosts file (Windows
users edit the Windows hosts file when browsing from Windows):

```text
127.0.0.1 auth.apps.localhost deploy.apps.localhost my-app.apps.localhost
```

Add another hostname for each app you deploy. Local mode uses HTTP cookies and
password sign-in; use HTTPS for public hosting and passkeys. The gateway stays
bound to `127.0.0.1`, and no database or backend port is published.

To choose another port, run `./install.sh --init --local` first, change both
`CADDY_PORT` and `PUBLIC_PORT` in `.env`, then run `./install.sh`.
`--local` never converts an existing production configuration.

## Server installation

### 1. Clone and initialize

Run these commands **on the server**:

```bash
git clone https://github.com/theosorus/nanodeploy.git
cd nanodeploy
./install.sh --init
```

`--init` creates `.env` and fills missing secrets, without needing Docker or
starting services. It leaves existing non-empty secrets intact. You can also
start with `cp .env.example .env`; `--init` will fill its blank secrets.

### 2. Configure your installation

Edit `.env` with your editor:

```dotenv
APPS_DOMAIN=apps.example.com
PUBLIC_SCHEME=https
COOKIE_SECURE=true
TIMEZONE=UTC
```

Replace `apps.example.com` with **your domain**. Use just the hostname, without
`https://`, `*`, a port or a path. Your console will be at
`https://deploy.<APPS_DOMAIN>`, accounts at `https://auth.<APPS_DOMAIN>`, and apps
at `https://<slug>.<APPS_DOMAIN>`.

`APPS_DIR` defaults to the absolute `var/apps` path inside your checkout. You
can leave it there or choose an absolute path on another persistent disk. The
checkout owner must be able to create and write it. For example:

```bash
sudo install -d -m 755 -o "$(id -un)" -g "$(id -gn)" /srv/nanodeploy/apps
```

Then set `APPS_DIR=/srv/nanodeploy/apps`. Quote paths containing spaces in
`.env`. Do not rename or move an existing data directory without planning its
mounts and backup. `.env` is read by Bash and Compose: keep it to simple
`NAME=value` assignments, with quoted literal values when necessary.

### 3. Start the platform

```bash
./install.sh --check
./install.sh
docker compose ps
```

`--check` validates configuration and Docker without changing files or services.
The installer creates persistent external networks, builds the platform images
and starts Postgres, the gateway, identity service and control plane. A short
identity-service restart during first boot can happen while its database role
is created.

Do not enable the legacy Pocket ID profile on a fresh installation. It is only
used by the [upgrade procedure](UPGRADING.md).

## HTTPS and DNS

The included Caddy listens on **`127.0.0.1:8080`** and speaks HTTP. A separate
HTTPS reverse proxy or tunnel must run in front of it. `CADDY_PORT` changes the
local listening port; `PUBLIC_PORT` is only needed when browsers use a
nonstandard external port.

Configure these two things independently:

1. **DNS:** `*.apps.example.com` must resolve to your server or tunnel. This
   covers `auth`, `deploy` and every app. If you publish an IPv6 record, make
   sure IPv6 actually reaches the same proxy.
2. **HTTPS routing:** preserve the original `Host`, set `X-Forwarded-Proto`
   correctly and route every matching hostname to `http://127.0.0.1:8080`.
   The certificate must cover **`*.apps.example.com`**; a certificate for
   `*.example.com` does not cover that extra level.

The bare `APPS_DOMAIN` is not an application and normally returns 404.

### Option A: your own reverse proxy

Use the [Nginx example](../examples/nginx.conf) with a host-installed Nginx,
replace its domain and certificate paths, then check the configuration with
`sudo nginx -t` before reloading it. Issue and renew the wildcard certificate
with your ACME client using a [DNS-01 challenge](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge).
Other reverse proxies work with the same Host and forwarding-header rules.
Expose HTTPS on port 443, and port 80 if your proxy uses it for redirects.
Do not publish the internal Docker services.

### Option B: a tunnel

A tunnel avoids inbound router ports. For example, configure a
[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/concepts/routing/)
hostname route for `*.apps.example.com` to `http://127.0.0.1:8080`, and a
wildcard DNS record pointing to that tunnel. Verify that your certificate plan
covers the hostname depth you chose; Cloudflare's default certificate for
`*.example.com` does not cover `auth.apps.example.com`. See their
[certificate coverage documentation](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/).

Keep the incoming Host unchanged. Do not set the tunnel's HTTP Host Header to
one fixed application name. If you put an additional access policy in front
of the console, allow signed webhooks at `/hooks/` through it when using Git
deployments.

### Trust the actual proxy

Set `TRUSTED_PROXY_CIDRS` to the **proxy source addresses as seen by Caddy**.
Docker may translate a host's loopback connection to a bridge gateway address,
so `127.0.0.1/32` alone is not always sufficient. Check a request's `remote_ip`
in the Caddy access log after deploying an app:

```bash
docker compose exec caddy tail -n 5 /var/log/caddy/apps.log
docker network inspect nanodeploy_edge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

For a gateway address such as `172.18.0.1`, use its exact `/32`, not the whole
private address space. Preserve the existing loopback entries if needed:
`TRUSTED_PROXY_CIDRS="127.0.0.1/32 ::1/128 172.18.0.1/32"` (replace the example).
Your public proxy must overwrite client-supplied forwarding headers. Recreate
Caddy after changes:

```bash
docker compose up -d caddy
```

A containerized proxy cannot reach the host's loopback using its own
`localhost`. Run it on the host, use host networking on Linux, or explicitly
design a private connection to Caddy. Keep the console and Docker proxies
isolated; do not attach external services to privileged platform networks.

## Create your administrator account

Once HTTPS works, retrieve the one-time setup link locally on the server:

```bash
docker compose logs control-plane | grep -A1 SETUP
```

Open the full link. Choose a username and password, then add a passkey from
your account page if you wish. No fixed administrator or default password
ships with Nanodeploy. Treat the setup link as a credential and do not post it
in an issue. Only administrators can open the console.

Open `https://deploy.<APPS_DOMAIN>`, then invite others from **People**.
The console asks you to confirm your sign-in before granting its host session.
Nanodeploy does not send email: hand each person their one-use invitation link.

## Deploy your first app

On your **development machine**, install Node.js 24 and `zip`, then:

```bash
cp -R templates/app-template ../my-app
cd ../my-app
npm ci
```

In `app.yaml`, set `name: My app` and `slug: my-app`. Keep `access: private`.
Generate the template's initial notes-table migration before the first deploy:

```bash
npm run db:generate
```

In the console choose **New application → Terminal & agents**, create a deploy
key for `my-app`, and copy it into your shell:

```bash
export NANODEPLOY_URL=https://deploy.apps.example.com
export NANODEPLOY_TOKEN=ndd_REPLACE_WITH_YOUR_APP_DEPLOY_KEY
npm run deploy -- -m "First deployment"
```

Use your own domain, or `http://deploy.apps.localhost:8080` for a local trial.
Open the returned app URL, sign in and create a note. It should still be there
after the backend sleeps and wakes. Deploy keys belong to one slug; the key
and `app.yaml` must agree. Keep the server-wide `DEPLOY_TOKEN` on the server.
See the [template guide](../templates/app-template/README.md) for development
and [the README](../README.md#push-to-deploy-from-github-or-gitlab) for Git deployment.

## Start on boot

Containers have restart policies. On a Linux host with systemd, also install
the boot unit so stopped app containers and generated routes are reconciled
after a reboot:

```bash
./scripts/configure-systemd.sh
cat var/systemd/nanodeploy.service
sudo cp var/systemd/nanodeploy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nanodeploy.service
```

The generator uses your checkout, app directory, Docker executable, Docker
data-root and current user. Choose another local account with `--user USER`
only if it owns the checkout, can write the data directory, and can access
Docker. Generated units stay in ignored `var/systemd/`; no machine paths enter
Git. Systems without systemd can start the stack with `docker compose up -d`
from their own boot supervisor.

Automatic updates are **optional and disabled by default**. Read
[UPGRADING.md](UPGRADING.md) before installing the generated update timer.

## Backups and everyday operations

```bash
docker compose ps                     # platform status
docker compose logs --tail=100 gate control-plane
docker compose stop                   # stop the platform
docker compose up -d                  # start it again
./scripts/backup.sh                   # make a full backup
```

The backup contains PostgreSQL databases and roles, app releases and migration
snapshots, app `/data` volumes, platform volumes, `.env` and the Git commit.
By default it keeps five backups in a `backups` directory beside `APPS_DIR`.
Set `BACKUP_DIR` and `BACKUP_KEEP` in `.env` to change that. Backups include
credentials and personal data: keep an encrypted copy on another machine.
They are taken when you run the script or the optional updater; no backup
schedule is installed automatically. For a consistent snapshot of apps writing
both database rows and files, stop their backends during the backup.

Preserve `NANODEPLOY_SECRET_KEY` with the corresponding database. Replacing it
makes encrypted app and Git credentials unreadable. Recovery requires the
matching database, app files, volumes and `.env`; see the
[recovery guide](OPERATIONS.md#restore-a-backup).

External networks survive `docker compose down`, but use `stop` for everyday
shutdown. Never use `down -v`, `docker volume prune` or delete `APPS_DIR` to
update: those can remove the persistent data. To uninstall, first back up,
disable any installed systemd units, delete hosted apps through the console,
then stop/remove the platform. Remove named volumes and storage only if you
intend to erase their data.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Installer cannot reach Docker | Start the daemon, select the local Linux Docker context, check `docker info` as the same user. |
| Permission denied creating app storage | Keep the generated `var/apps` path or create your custom directory with the checkout owner as above. |
| Port 8080 is in use | Change `CADDY_PORT`; also change `PUBLIC_PORT` for a local trial and the upstream address in your proxy. |
| `server not found` / DNS error | Check the wildcard **DNS record**, not only the tunnel route. Try `nslookup auth.<APPS_DOMAIN>` and a new app hostname. |
| Certificate error | The certificate must cover `*.<APPS_DOMAIN>`, including its full subdomain depth. |
| Empty page or `no such app` | Access `deploy.<APPS_DOMAIN>` or a deployed app; the bare domain has no home page. Verify the proxy preserves Host. |
| Login redirects to HTTP or loops | Check `PUBLIC_SCHEME`, `PUBLIC_PORT`, cookie settings and trusted proxy addresses; recreate gate, control-plane and Caddy with `docker compose up -d`. |
| Local sign-in does not persist | Use the same `*.apps.localhost` hostname throughout; check `COOKIE_SECURE=false` and restart with `docker compose up -d`. |
| No setup link yet | Check `docker compose logs --tail=100 postgres control-plane`; database startup and first reconciliation can take time. A legacy import needs its original Pocket ID settings. |
| Caddy build fails or is killed | Check free disk/RAM, a modern Docker/kernel, and access to public registries. Build on a larger host of the same architecture or add resources if needed. |
| A network has incompatible isolation settings | Check for an older installation or a naming collision. Back up and follow the upgrade guide; do not delete networks used by running apps. |
| First API request returns HTML | A sleeping app is waking. Use the template client, which retries the waiting page. |
| Template says a table is missing | Run `npm run db:generate`, keep `migrations/` in the bundle and deploy again. |
| Deploy key returns 403 | Confirm its slug matches `app.yaml` and that the request uses an app deploy key. |
| Outbound request fails | Node 24 and npm use the HTTP/S proxy; other clients must support it. Private/LAN destinations and raw TCP are blocked by design. |

For a bug report, include OS/architecture, Docker/Compose versions, the failing
command and **redacted** logs. Do not attach `.env`, backups, setup links or
access tokens. See [CONTRIBUTING.md](../CONTRIBUTING.md) and
[SECURITY.md](../SECURITY.md).
