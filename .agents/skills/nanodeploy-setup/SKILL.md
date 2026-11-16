---
name: nanodeploy-setup
description: "Installs, configures, updates and repairs the Nanodeploy platform itself: a local trial on a laptop, or a production install on a Linux server or VPS with install.sh, .env, wildcard DNS and HTTPS through a reverse proxy or tunnel, the first administrator account, connecting GitHub or GitLab for push-to-deploy, start on boot, backups, restores and updates. Use when the user wants to set up, try, host, upgrade, back up or troubleshoot Nanodeploy (sign-in loop, 404, certificate error, webhook not arriving, no setup link), or asks how to get a server ready for their apps. Not for writing or deploying an app: use nanodeploy-app."
compatibility: "The platform needs 64-bit Linux (x86-64 or ARM64), Docker Engine 28+ with Compose v2, Git, Bash and OpenSSL. A local trial also works with Docker Desktop (Linux containers) on macOS or Windows/WSL2."
license: MIT
---

# Nanodeploy setup

Nanodeploy is a self-hosted platform: Caddy, a sign-in gateway (gate), a
control plane, Postgres and a few proxies, all in Docker Compose, started by
`./install.sh` from a clone of the repository. It hosts apps at
`<slug>.<domain>` and its console at `deploy.<domain>`.

This file picks the procedure. Each procedure lives in `references/`: **read
the whole file before running its first command.** In a clone of the
repository, `docs/INSTALL.md`, `docs/OPERATIONS.md` and `docs/UPGRADING.md`
hold the same procedures in more depth; prefer them when they disagree with
this skill, they track the code.

## 1. Where do the commands run?

- **You have a shell on the target machine** (the user said so, or you run on
  it): run the commands yourself, one step at a time, and check each result.
- **You do not** (claude.ai, another computer): give the user one step at a
  time, ask them to paste the output, read it, then give the next step.
- Never guess an SSH host, user or path. Never connect to a server the user
  did not name.

## 2. Pick the procedure

| The user wants | Read |
|---|---|
| To try Nanodeploy on their own computer, no domain | [references/local-trial.md](references/local-trial.md) |
| To host it for real on a server, with a domain and HTTPS | [references/server-install.md](references/server-install.md) |
| Push-to-deploy from GitHub or GitLab | [references/git-forges.md](references/git-forges.md) |
| Backups, restore, updates, start on boot, shutdown, uninstall | [references/operations.md](references/operations.md) |
| Something is broken | [references/troubleshooting.md](references/troubleshooting.md) |

Ask first, in one message, what you need to choose: local trial or real
server; the domain they will use; how HTTPS reaches the machine (their own
reverse proxy, a tunnel such as Cloudflare Tunnel, or not decided); the
machine (OS, CPU architecture, RAM, disk).

## 3. Rules that protect the user's data

1. **Back up before any update or risky change**: `./scripts/backup.sh`.
2. **Never run** `docker compose down -v`, `docker volume prune`,
   `docker system prune --volumes`, or delete `APPS_DIR`, `var/` or `.env`.
   They destroy apps, databases or keys. Use `docker compose stop` to stop.
3. **Keep `NANODEPLOY_SECRET_KEY`** exactly as it is once set. Replacing it
   makes every stored secret and forge credential unreadable.
4. **Secrets stay on the machine.** `.env`, `DEPLOY_TOKEN`, the SETUP link,
   invitation links and deploy keys are credentials: never paste them in an
   issue, a commit or a public place. When showing `.env`, hide the secret
   values.
5. **Confirm before anything destructive or hard to undo** (deleting an app,
   restoring a backup, rotating a key), even if it looks routine.
6. **One Nanodeploy per Docker daemon.** Never run `install.sh --local` on a
   machine that already runs a production install.
7. **Edit `.env` with simple `NAME=value` lines**; quote values with spaces.
   Never commit it.

## 4. Verify, do not assume

Every procedure ends with checks. Run them (or have the user run them) and
read the output before saying it works:

```bash
./install.sh --check          # configuration and Docker, changes nothing
docker compose ps             # every service "running" or "healthy"
docker compose logs --tail=50 control-plane gate caddy
```

A working installation means: the console opens at `deploy.<domain>`, an
administrator can sign in, and a test app deploys, opens, sleeps and wakes up.
The nanodeploy-app skill builds that test app; the template's notes app is
enough.

## 5. Report to the user

End with: what is running and where (console URL, account URL), what is left
for them to do (DNS record, certificate, systemd unit, first backup), and
where their secrets live (`.env` on the server, to back up off the machine).
