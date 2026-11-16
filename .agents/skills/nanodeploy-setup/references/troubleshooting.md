# Troubleshooting the platform

## Contents
- First, collect facts
- Installation
- Reaching the console
- Signing in
- Apps
- Git deployments
- Reporting a bug

## First, collect facts

Before changing anything, run these and read the output:

```bash
./install.sh --check
docker compose ps
docker compose logs --tail=100 caddy gate control-plane postgres
grep -E '^(APPS_DOMAIN|PUBLIC_SCHEME|PUBLIC_PORT|COOKIE_SECURE|CADDY_PORT|TRUSTED_PROXY_CIDRS)=' .env
```

The last command shows only non-secret settings; never print the whole `.env`.

## Installation

| Symptom | Check / fix |
|---|---|
| `install.sh` cannot reach Docker | Daemon running, local Linux context, `docker info` works as the same user (log in again after joining the `docker` group). |
| Docker version refused | Docker Engine 28+ needed. Existing old hosts only: `NANODEPLOY_ALLOW_LEGACY_DOCKER=true` (see `docs/UPGRADING.md`). |
| Permission denied on app storage | Keep the default `var/apps`, or create `APPS_DIR` owned by the checkout user. |
| Port 8080 already in use | Change `CADDY_PORT` (and `PUBLIC_PORT` for a local trial) and the proxy's upstream. |
| Caddy build fails or is killed | Free RAM and disk, a recent kernel and Docker, access to public registries and Go module sources. |
| `a network has incompatible isolation settings` | An older install or a name clash: back up and follow `docs/UPGRADING.md`; never delete networks used by running apps. |
| No SETUP line in the logs | Wait for Postgres and the control plane; `docker compose logs --tail=100 postgres control-plane`. |

## Reaching the console

| Symptom | Check / fix |
|---|---|
| `server not found` / DNS error | The **wildcard DNS record** exists, not only a tunnel route: `nslookup auth.<APPS_DOMAIN>` and a random name like `nslookup zz.<APPS_DOMAIN>`. |
| Certificate error | The certificate covers `*.<APPS_DOMAIN>` at that exact depth. |
| Empty page, 404 or `no such app` | Use `deploy.<APPS_DOMAIN>`, not the bare domain. The proxy or tunnel must keep the original `Host` (no fixed Host header). |
| 502 from the proxy | Its upstream is `http://127.0.0.1:<CADDY_PORT>`; a containerised proxy cannot use its own localhost. |
| Webhooks or the API blocked by an access page | An extra access layer (Cloudflare Access, VPN) is in front: let `/hooks/` (and the API paths deploy keys use, `/api/`) through, or keep deploys on the dashboard. |

## Signing in

| Symptom | Check / fix |
|---|---|
| Redirects to `http://` or loops | `PUBLIC_SCHEME=https`, `COOKIE_SECURE=true`, the proxy sends `X-Forwarded-Proto: https`, `TRUSTED_PROXY_CIDRS` holds the proxy's real address; then `docker compose up -d`. |
| Local trial sign-in does not stick | Always the same `*.apps.localhost` names; `COOKIE_SECURE=false` in local mode; `docker compose up -d`. |
| Passkeys refused | Passkeys need HTTPS and the same domain they were created on. |
| "this account is not an administrator" | Only administrators open the console; another administrator promotes the account in People & access. |
| Every visitor rate-limited together | `TRUSTED_PROXY_CIDRS` misses the proxy address (server-install.md, step 6). |

## Apps

| Symptom | Check / fix |
|---|---|
| Deploy log: `WARNING: <host> does not resolve` | Wildcard DNS missing for the app's name. |
| An app never wakes | `docker compose logs --tail=50 caddy` and the app's Logs tab; the image may have been removed: `docker compose restart control-plane` reconciles and rebuilds it. |
| After a reboot, apps missing or not routed | The systemd unit is not installed or failed: `systemctl status nanodeploy`. Restarting the control plane reconciles. |
| Outbound calls from apps fail | Apps reach public HTTP/S on ports 80 and 443 through the egress proxy only; private hosts, SMTP and raw TCP are blocked by design. |
| Disk filling up | `docker system df`; old releases are pruned automatically (10 kept); backups accumulate in `BACKUP_DIR` (`BACKUP_KEEP`). |

## Git deployments

| Symptom | Check / fix |
|---|---|
| The Git tab asks for `NANODEPLOY_SECRET_KEY` | Run `./install.sh` (it generates a missing key), then restart the control plane. Never replace an existing key. |
| Pushes do nothing, Build now works | Webhooks blocked: `/hooks/` must be reachable from the internet; check the forge's webhook delivery log. |
| A repository is missing from the list | GitHub: **Choose repositories**. GitLab: connect that project with its own token. |
| Builds fail with expired credentials | GitLab token expired: reconnect the project with a new token. |
| Builds wait for memory | Under ~1.2 GB free. Fewer awake apps, more RAM, or ZIP deployments. |

## Reporting a bug

Include the OS and architecture, Docker and Compose versions, the command and
**redacted** logs. Never attach `.env`, a backup, a SETUP or invitation link,
or any key. Security issues follow `SECURITY.md`, not a public issue.
