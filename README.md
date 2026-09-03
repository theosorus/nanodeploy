# Nanoploy

A self-hosted mini-Vercel sized for a 4 GB machine.

*[Version française](README.fr.md)*

Deployed apps sleep by default and cost nothing. The first request wakes one in
about a second. A single Postgres instance is shared by every app, with one
database and one role each. One account gives access to all of your apps, and
any app can be flipped between private, group-restricted and public in a click.

It runs on a Jetson Nano, a Raspberry Pi 4/5, an old laptop, or any box that can
run Docker and stay on.

## What is in the box

| Component | Role | RAM at rest |
|---|---|---|
| Caddy + Sablier plugin | routing, static frontends, waking apps | ~25 MB |
| Sablier | stops and starts containers on demand | ~15 MB |
| Postgres 16 | shared database, one database per app | ~60 MB |
| Pocket ID | identity provider, passkeys, accounts | ~15 MB |
| tinyauth v5 | forward-auth in front of every private app | ~10 MB |
| control plane | bundle upload, provisioning, routes | ~50 MB |
| socket proxies | least-privilege Docker access, one per consumer | ~10 MB |

A woken app costs about 40 MB and is capped at 256 MB.

## What you need

- A machine with Docker and Docker Compose v2, ideally with storage that is not
  an SD card.
- A domain you control, and a wildcard `*.apps.example.com` pointing at the
  machine. A [Cloudflare tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
  is the easiest way in from behind a home router; any reverse proxy that
  terminates TLS works.
- Node 20 on your development machine, to build and deploy apps.

## Preparing the host

Do this once, before installing. These three points are what kills a homelab on
an SD card.

1. Move Docker's storage to an external disk, in `/etc/docker/daemon.json`:

   ```json
   {
     "data-root": "/mnt/ssd/docker",
     "log-driver": "json-file",
     "log-opts": { "max-size": "10m", "max-file": "3" }
   }
   ```

   On a Jetson, add `RequiresMountsFor=/mnt/ssd` to Docker's systemd unit, or a
   boot that happens before the disk is mounted will recreate an empty
   data-root.

2. Go headless: `sudo systemctl set-default multi-user.target` frees about
   500 MB on a Jetson.

3. On JetPack 4, update `libseccomp2` from bionic-backports, otherwise recent
   Debian images die with `Illegal instruction`.

## Installing

```bash
git clone https://github.com/<you>/nanoploy && cd nanoploy
./install.sh          # writes .env with fresh secrets, then stops
$EDITOR .env          # set APPS_DOMAIN and APPS_DIR
./install.sh          # builds and starts everything
```

`install.sh` generates `POSTGRES_PASSWORD`, `POCKETID_ENCRYPTION_KEY` and
`DEPLOY_TOKEN`, checks the host, and refuses to start on a configuration that
would come up broken or wide open. Building Caddy with the Sablier plugin
compiles from source: about 10 minutes on a Jetson.

Then:

1. Point your tunnel or reverse proxy at `http://localhost:8080` (change with
   `CADDY_PORT`), with a **wildcard** hostname `*.apps.example.com` and
   `apps.example.com` itself. With a Cloudflare tunnel that is one entry under
   *Public Hostname* with the subdomain set to `*`, service `HTTP` →
   `localhost:8080`.

   Do not skip the wildcard. Without it, every app deploys and runs perfectly
   and none of them resolves: the browser says "server not found" and nothing in
   the dashboard explains why. Deploys warn about it, but only after the fact.
2. Open `https://id.apps.example.com` and create the Pocket ID admin account.
3. In Pocket ID, create an OIDC client for tinyauth with callback
   `https://auth.apps.example.com/api/oauth/callback/generic`. Put the client id
   and secret in `.env`, then `docker compose up -d tinyauth`.
4. In Pocket ID, create an API key, put it in `POCKETID_API_KEY`, then
   `docker compose up -d control-plane`. This is what enables the People tab.
5. Open `https://deploy.apps.example.com`, People tab, and pick an admin group.
   Read the next section first.
6. Put `DEPLOY_TOKEN` in your password manager.

The token lives in `.env` and doubles as the CLI bypass password in the
Caddyfile, where it is matched literally. If you change it, restart both
containers that hold it: `docker compose up -d caddy control-plane`.

## Who may drive the console

The dashboard deploys arbitrary code and drives Docker. Whoever can open it
effectively has root on the machine.

A fresh install is single-user, so **every account that can sign in is an
administrator**. That is fine while you are alone, and the dashboard says so in
red until you fix it. Two things happen the moment you stop being alone:

- The dashboard refuses to create a second account until an admin group is set.
- Once set, only members of that group reach `/api/*`; everyone else keeps
  access to the apps themselves and sees a plain "you are not an administrator"
  page on the console.

To set it: People tab → create a group (say `admins`) → click its chip on your
own row to join it → pick it in the red panel → Apply. The control plane checks
with Pocket ID that you really belong to the group before applying, so the
change cannot lock you out of your own console, and it does not wait for your
session to be refreshed.

You can also pin it in `.env` with `ADMIN_GROUP=admins`, which makes it
read-only in the dashboard. Clearing it again requires the deploy token, on
purpose: it is the one change that widens access to everybody.

Recommended on top: put `deploy.apps.example.com` behind Cloudflare Access or an
equivalent outer layer.

## The dashboard

Two tabs, on `deploy.apps.example.com`.

**Apps** — host memory in use, a drop zone for `.zip` bundles, and one row per
app. Clicking a row opens the detail: access mode (private, groups, public),
environment variables, recent logs, wake and delete.

**People** — the list of accounts with their groups as clickable chips.
Inviting someone creates the account in Pocket ID and returns a single-use link
to pass along; there is no password, the person enrolls a passkey. Groups
created here become available in every app's access selector.

Accounts live only in Pocket ID; the dashboard just drives its API. Without
`POCKETID_API_KEY`, the tab simply links out to Pocket ID. The API paths used
(`/api/users`, `/api/user-groups`) depend on the Pocket ID version, worth
checking if the tab returns an error.

**Isolation** — each app runs as a non-root container with all capabilities
dropped, a read-only root filesystem, `/data` on its own volume and a memory
cap, on a network that only carries Caddy and Postgres. The Docker socket,
Sablier, tinyauth and the control plane are unreachable from an app. See
[SECURITY.md](SECURITY.md) for the full boundary list and the accepted limits.

## Deploying an app

```bash
cp -r templates/app-template my-app && cd my-app
npm install
export NANOPLOY_URL=https://deploy.apps.example.com
export NANOPLOY_TOKEN=...
npm run deploy
```

The build happens on your machine. The server never compiles anything heavy: it
receives a zip holding `dist/`, `server.js`, `app.yaml` and `migrations/`, builds
a tiny image and starts the container.

Or, without a terminal: drop the zip on the dashboard.

A cold app — the default — is **put back to sleep immediately after deploying**:
a container started outside a Sablier session would never stop on its own. HTML
and assets are served instantly by Caddy without waking anything; only the first
`/api/*` request triggers the wake, with a waiting page of about a second that
the template's `src/client.ts` retries away. Only apps with `idle.warm: true`
run permanently.

The subdomains `deploy`, `auth`, `id` and `www` are reserved by the platform and
rejected as slugs.

## The skill

`skills/nanoploy-app/` holds a Claude skill that knows the stack, the
scale-to-zero constraints and the deployment procedure. Once installed, "build
me an app that tracks my expenses" produces something conformant and
deployable.

The template ships `src/client.ts`, a `fetch` wrapper that retries requests that
landed on Sablier's waiting page. Not using it is the number one cause of apps
that "work, then silently break" on the first wake.

## After a power cut

Nothing to do, provided you installed the unit once:

```bash
sudo cp nanoploy.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable nanoploy
```

What happens on reboot:

1. systemd waits for the storage to be mounted, then restarts the platform.
2. App containers are still there, simply stopped. So are the Caddy routes, they
   are files. The first request on an app wakes it.
3. The control plane reconciles at startup: it re-reads the `apps` table in
   Postgres and recreates any missing container, image or route. Images are
   rebuilt from the bundle stored in `APPS_DIR` (the extracted files live there,
   not the zip), then cold apps are put back to sleep. The heal also covers an
   image deleted by hand while the app was asleep.

To force a reconcile by hand:

```bash
curl -X POST -H "Authorization: Bearer $NANOPLOY_TOKEN" \
  https://deploy.apps.example.com/api/reconcile
```

An app that must answer instantly, with no waiting page, sets `idle.warm: true`
in its manifest. It then opts out of scale-to-zero, runs permanently and
restarts with the machine. That costs ~40 MB, so keep it to one or two apps.

**Never run `docker compose down`.** It deletes the networks, and app
containers, which do not belong to the compose project, become unstartable. Use
`docker compose stop`. The networks are declared `external` to limit the damage,
but the habit is still the right one.

## Backups

Nothing is backed up automatically. Set this up right away:

```bash
# nightly, one dump for every app database
docker compose exec -T postgres pg_dumpall -U postgres | gzip > /mnt/ssd/backups/pg-$(date +%F).sql.gz
```

Plus an encrypted off-site copy with restic. A shared database is a single point
of loss for every app, and app secrets sit in it in clear text, so encrypt those
dumps. On the image side, one image per app is kept (automatic prune on every
deploy); bundles in `APPS_DIR` are only removed when the app is deleted.

## Known limits

- No automatic rollback: a deployment replaces the container.
- No centralised logs, `docker logs app-<slug>` does the job.
- An app's environment variables and database password sit in clear text in the
  `apps` table of the control database. Acceptable on a homelab, worth
  remembering when you handle backups.
- The first wake shows a waiting page for about a second (an SPA fetch works
  around it through `src/client.ts`, which retries).
- Websockets do not survive going to sleep, by design.
- Caddy answers 404 for any unknown subdomain, including a deleted app.
- Apps can see each other on the shared network: do not host an app open to
  strangers next to something sensitive.
- Deleting an app keeps its Postgres database but erases its `/data` volume.

## Licence

MIT, see [LICENSE](LICENSE). Contributions welcome, see
[CONTRIBUTING.md](CONTRIBUTING.md).
