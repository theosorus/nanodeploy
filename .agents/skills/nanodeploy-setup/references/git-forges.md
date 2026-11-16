# Connecting GitHub or GitLab

Push-to-deploy: a push to a connected branch builds and deploys the app; each
pull request gets a private preview. This file sets up the server side. How an
app repository must look is in the nanodeploy-app skill (deploy-git.md).

## Prerequisites

- A working server install with HTTPS (local trials cannot receive webhooks).
- `NANODEPLOY_SECRET_KEY` set in `.env` (the installer generates it); forge
  credentials are stored encrypted with it. Without it the Git tab says so.
- The forges are github.com and gitlab.com.
- Webhooks must reach `https://deploy.<domain>/hooks/` from the internet. If
  the console sits behind an extra access layer (Cloudflare Access, a VPN,
  basic auth), add a bypass for the `/hooks/` path only. Webhooks are signed
  and checked by the control plane.

## GitHub

1. Console → **Git deployments** → **Connect GitHub** (optionally an
   organisation name).
2. GitHub opens and asks to create a **private GitHub App** for this server;
   the user confirms. It requests read access to contents, write access to
   commit statuses and pull requests, and receives push and pull request
   events.
3. **Choose repositories**: the user picks which repositories the app may
   read. A repository created later must be added here before it can be
   connected.

## GitLab

One connection per project:

1. On GitLab: the project → Settings → Access tokens → new token, role
   **Maintainer**, scopes **api** and **read_repository**, with an expiry the
   user will remember.
2. Console → **Git deployments** → **Connect a GitLab project**: `group/project`
   and the token. The webhook is installed on the project automatically.
3. When the token expires, builds stop: remove the connection and connect
   again with a new token.

## Connect a repository to an app

Console → **Git deployments** → **Deploy a repository**: forge, repository,
branch (e.g. `main`), project directory (`.` or the folder holding
`app.yaml`), previews on or off → **Deploy from this repository**.

The repository must already contain a valid `app.yaml` on that branch: its
`slug` becomes the app. The first build starts at once.

## Check it

- The build appears in **Git deployments** with its log; it ends `deployed`.
- The commit on the forge gets a green `nanodeploy` status linking to the app.
- A push to the branch queues a new build within seconds. If only **Build
  now** works, webhooks are not arriving: check the `/hooks/` path through the
  proxy, tunnel and any access layer, and the forge's webhook delivery log
  (GitHub App → Advanced; GitLab project → Settings → Webhooks).

## Resources

One build runs at a time, in a container limited to 1.5 GB of memory and 10
minutes, and waits when the server has less than about 1.2 GB free. On a 4 GB
server with many awake apps, builds may wait or fail: add memory, or use ZIP
deployments, which build on the developer's machine.
