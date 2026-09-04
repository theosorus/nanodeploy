# Nanodeploy

**Your own Vercel, on a 4 GB box in a cupboard.** Apps sleep when nobody is
using them, wake in about a second, and share one Postgres and one login.

<p align="center">
  <img src="docs/dashboard.png" alt="The Nanodeploy dashboard: memory meter and the list of deployed apps" width="660">
</p>

![MIT](https://img.shields.io/badge/license-MIT-1f4b8f) ![idle footprint](https://img.shields.io/badge/idle-~180%20MB-1f8f60) ![built for](https://img.shields.io/badge/built%20for-4%20GB%20ARM-7a5610)

---

## The idea

Small personal apps are cheap to write and annoying to host. A budget tracker
you open twice a week does not deserve a VPS, and putting five of them on one
tiny machine means five idle Node processes eating the RAM you needed for the
sixth.

So Nanodeploy stops them. An app with no traffic is a stopped container: zero
RAM, zero CPU. The next request to reach it starts it back up before the page
finishes loading. On a Jetson Nano with five apps deployed, two of them awake,
the whole machine sits at **1.4 GB of 4 GB**, and that includes Postgres, an
identity provider and the gateway.

You still get the parts that make hosting worth it: a real domain per app, HTTPS,
one account across everything, a database per app, and a deploy that is one
command or one drag of a `.zip`.

## What it costs to run

| Component | Job | RAM at rest |
|---|---|---|
| Caddy + Sablier plugin | routing, static files, waking apps | ~25 MB |
| Sablier | stops and starts containers on demand | ~15 MB |
| Postgres 16 | one database and one role per app | ~60 MB |
| Pocket ID | accounts, passkeys, groups | ~15 MB |
| tinyauth | forward-auth in front of every private app | ~10 MB |
| control plane | uploads, provisioning, routes | ~50 MB |
| two socket proxies | least-privilege Docker access | ~10 MB |

A woken app costs about 40 MB and is capped at 256 MB. An app that must answer
instantly can opt out of sleeping for that same 40 MB, permanently.

## Deploying

```bash
cp -r templates/app-template my-app && cd my-app
npm install
export NANODEPLOY_URL=https://deploy.apps.example.com
export NANODEPLOY_TOKEN=...
npm run deploy
```

Your machine builds; the server never compiles anything heavy. It receives a zip
holding `dist/`, `server.js`, `app.yaml` and `migrations/`, builds a small image,
runs the migrations once, and puts the container straight back to sleep.

No terminal handy? Drag the zip onto the dashboard.

The whole contract with the platform is one file:

```yaml
name: Expenses
slug: expenses          # -> expenses.apps.example.com
access: private         # public | private | groups
backend: { entry: server.js, port: 3000 }
database: { enabled: true, migrations: ./migrations }
idle: { timeout: 10m, warm: false }
env: [OPENAI_API_KEY]   # names only, values are typed in the dashboard
```

## Running it

Click an app to get its access mode, its environment variables, its recent logs
and how much memory it is using right now.

<img src="docs/app-detail.png" alt="An app's detail panel: access mode, environment variables, recent logs" width="560">

Access is a dropdown, not a redeploy. **Private** means any account you created.
**Groups** narrows it to the people you choose. **Public** means the whole
internet, and the dashboard says so out loud before you do it.

Environment variables are set here and never live in your repo. Values are
write-only in the interface: you can replace a secret, you cannot read it back.

## One account for everything

<img src="docs/people.png" alt="The people tab: invite by email, group chips, admin group" width="560">

Accounts live in Pocket ID and there is no password anywhere: you invite someone
by username and email, hand them a single-use link, and they enroll a passkey.
That one account then opens every app they are allowed to see, and your apps
never write a line of authentication code — the gateway hands them the user's
identity in a header.

Groups created here show up in every app's access selector.

Because the console can deploy code and drive Docker, whoever reaches it
effectively has root on the machine. A fresh install is single-user, so it stays
open; the moment you invite a second person the dashboard makes you pick an admin
group first, and warns in red until you do.

## How it is wired

```mermaid
flowchart LR
    net([Internet]) --> tun[Tunnel or reverse proxy<br/>terminates TLS]
    tun --> caddy[Caddy + Sablier plugin]

    subgraph edge[network: edge]
        caddy --- auth[tinyauth]
        auth --- pid[Pocket ID]
        caddy --- sab[Sablier]
        cp[control plane]
        sab --- sp2[socket proxy<br/>start / stop only]
        cp --- sp1[socket proxy<br/>build / exec]
    end

    subgraph appsnet[network: apps]
        a1[app-expenses]
        a2[app-notes]
    end

    subgraph datanet[network: data, no internet]
        pg[(Postgres)]
    end

    caddy --> a1
    caddy --> a2
    a1 --> pg
    a2 --> pg
    cp --> pg
    sp1 -.-> dock[[Docker socket]]
    sp2 -.-> dock
```

Read it as one rule: **an app can reach the gateway and its own database, and
nothing else.** The Docker socket, Sablier, tinyauth and the control plane all
live on a network an app is not connected to, because an app is arbitrary code
and reaching the socket is a root escape. Neither Sablier nor the control plane
touches the raw socket either; each gets a proxy allowed to do only its job.

Apps run as a non-root user with every capability dropped, a read-only root
filesystem, a 256 MB cap and no published port.

## What you need

- A machine with Docker and Compose v2, and storage that is not an SD card.
- A domain, and a **wildcard** `*.apps.example.com` pointing at the machine. A
  [Cloudflare tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
  is the easiest way through a home router; any TLS-terminating proxy works.
- Node 20 on your laptop, to build apps.

```bash
git clone https://github.com/<you>/nanodeploy && cd nanodeploy
./install.sh          # writes .env with fresh secrets, then stops
$EDITOR .env          # set APPS_DOMAIN and APPS_DIR
./install.sh          # builds and starts everything
```

Then point your tunnel at `http://localhost:8080`, create your account at
`https://id.apps.example.com`, wire an OIDC client for tinyauth, and drop a
Pocket ID API key into `.env`. The installer prints each step with your own
domain filled in.

> **The wildcard is not optional.** Two settings share the word: your tunnel's
> ingress rule decides where a request goes once it arrives, and the DNS record
> is what makes it arrive. With the tunnel rule but no `*` DNS record, every app
> deploys and runs perfectly while the browser says "server not found". Deploys
> warn about it, but only after the fact.

## Living with it

Install the unit once and the machine comes back on its own after a power cut:

```bash
sudo cp nanodeploy.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable nanodeploy
```

On boot the control plane reconciles: it re-reads the `apps` table and rebuilds
any missing container, image or route from the bundles on disk, then puts the
cold ones back to sleep. A wiped Docker data-root heals the same way. Force it
by hand with `POST /api/reconcile`.

Two habits worth having:

```bash
# never "docker compose down": it deletes the networks, and app containers
# are not part of the compose project, so they become unstartable
docker compose stop

# nightly, every app database in one file
docker compose exec -T postgres pg_dumpall -U postgres | gzip > backups/pg-$(date +%F).sql.gz
```

## Building apps with Claude

`skills/nanodeploy-app/` is a Claude skill that knows the stack, the
scale-to-zero constraints and the deploy procedure. Installed, "build me
something to track my expenses" produces a conformant, deployable app — and asks
you about the art direction first, so it does not look like every other
generated app.

## What it does not do

Stated plainly, because finding out later is worse:

- **No rollback.** A deploy replaces the container. Keep your bundles.
- **Apps can see each other.** They share a network. Do not put an app open to
  strangers next to something sensitive.
- **App secrets sit in clear text** in the control database. Encrypt your backups.
- **Nothing is backed up for you.** One shared Postgres is one point of loss for
  every app. Set up `pg_dumpall` on day one.
- **Websockets do not survive sleeping.** Poll, or use SSE that reconnects.
- **The first request after sleeping gets a waiting page**, not JSON. The
  template's fetch wrapper retries it; a bare `fetch` breaks in silence.
- **No rate limiting.** Put the console behind an outer access layer.

[SECURITY.md](SECURITY.md) has the full threat model: what is enforced, and what
is deliberately not.

## Licence

MIT. See [LICENSE](LICENSE) and [CONTRIBUTING.md](CONTRIBUTING.md).
