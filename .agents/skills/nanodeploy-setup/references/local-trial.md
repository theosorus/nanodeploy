# Local trial

The whole platform on one computer, over plain HTTP, at
`http://deploy.apps.localhost:8080`. No domain, no cloud account, no Node.

## Requirements

- Docker running Linux containers, with Compose v2: Docker Engine on Linux,
  or Docker Desktop on macOS or Windows (WSL2 backend).
- Git and Bash. On Windows, run everything **inside WSL2** (Ubuntu), in the
  Linux filesystem (`~/...`), not under `/mnt/c/`.
- About 4 GB of free RAM and 10 GB of disk. The first build compiles Caddy and
  takes several minutes.

Check:

```bash
docker info --format '{{.OSType}} {{.ServerVersion}}'   # must print linux and a version
docker compose version
git --version
```

## Steps

```bash
git clone https://github.com/theosorus/nanodeploy.git
cd nanodeploy
./install.sh --local
```

`--local` writes a private `.env` with random secrets, stores apps in
`var/apps`, builds the images and starts everything. Running it again keeps
existing secrets and data. It refuses to convert an existing production
configuration.

Get the one-time administrator link:

```bash
docker compose logs control-plane | grep -A1 SETUP
```

If nothing prints yet, wait a minute (Postgres and the first reconciliation
start first) and run it again.

Open the full link, choose a username and a password, then open
`http://deploy.apps.localhost:8080`. Accounts live at
`http://auth.apps.localhost:8080`.

## If the names do not resolve

Most browsers resolve `*.localhost` to the computer on their own. If yours
does not, add to the hosts file of the machine **running the browser**
(`/etc/hosts`, or `C:\Windows\System32\drivers\etc\hosts` on Windows, as
administrator):

```text
127.0.0.1 auth.apps.localhost deploy.apps.localhost my-app.apps.localhost
```

Add one name per app you deploy.

## Another port

Port 8080 taken:

```bash
./install.sh --init --local
# edit .env: set CADDY_PORT and PUBLIC_PORT to the same free port, e.g. 8090
./install.sh
```

## Deploy a first app

Hand over to the nanodeploy-app skill. For a quick test, from the repository:

1. In the console: **New application → Terminal & agents**, create a deploy
   key for the slug `my-app`.
2. On the same computer, with Node 24:

```bash
cp -R templates/app-template ../my-app && cd ../my-app
npm ci
# in app.yaml: name: My app, slug: my-app
npm run db:generate
export NANODEPLOY_URL=http://deploy.apps.localhost:8080
export NANODEPLOY_TOKEN=ndd_...
npm run deploy -- -m "First deployment"
```

3. Open `http://my-app.apps.localhost:8080`, sign in, add a note. Stop the
   container (`docker stop app-my-app`) and reload: the note survives and the
   app wakes up.

## Limits of the trial

HTTP only: passkeys need HTTPS, so sign in with a password. Git deployments
need webhooks from GitHub or GitLab to reach the machine, which a laptop
usually cannot receive; **Build now** in the console still works. Stop it with
`docker compose stop`, start it with `docker compose up -d`.
