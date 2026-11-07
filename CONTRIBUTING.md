# Contributing

Contributions, bug reports and documentation improvements are welcome.
Nanodeploy targets self-hosted **64-bit Linux servers on x86-64 and ARM64**,
starting around 4 GB of RAM. A small footprint and simple operations guide its
design; no particular machine, maintainer account or hosting provider is required.

Use [the installation guide](docs/INSTALL.md) or its
[French version](docs/INSTALL.fr.md) for a full local trial. For dashboard work,
`node scripts/preview-ui.mjs` provides fixtures without Docker or a database.

## Propose a change

Search existing issues first. Bug reports should include OS/architecture,
Docker/Compose versions, reproduction steps and redacted logs. Open an issue
before a large architectural change so its scope can be discussed. Small fixes
and documentation changes can go straight to a pull request.

Fork the repository, create a branch, make a focused change and describe the
problem, resulting behavior and checks you ran. Tests should cover meaningful
behavior. Documentation corrections do not need artificial tests. Please keep
the community [code of conduct](CODE_OF_CONDUCT.md) in mind.

Do not publish `.env`, backups, real accounts, setup links, deployment tokens,
private hostnames or machine-specific runbooks. Use reserved example domains
and synthetic fixtures. Report vulnerabilities through [SECURITY.md](SECURITY.md).

## Before you open a pull request

- **Keep the resting footprint down.** Sleeping apps should consume no backend RAM.
  A change that adds a permanently running service needs to justify its RAM.
- **Keep the stack fixed.** One gateway, one identity provider, one Postgres,
  one control plane. Discuss changes that add operational dependencies first.
- **Assume apps are hostile.** Anything reachable from an app's private bridge is
  reachable by arbitrary code. Read `SECURITY.md` before touching networking,
  the socket proxies, or the generated Caddy config.
- **Assume the machine loses power.** Every state change must survive a hard
  reboot: Postgres holds the truth, Docker and Caddy are rebuilt from it by the
  reconcile pass.

## Checks

Use Node.js 24. Install gate dependencies as well: control-plane integration
tests start the real gate. From the repository root:

```bash
npm --prefix control-plane ci
npm --prefix gate ci
npm --prefix templates/app-template ci
node --test scripts/install.test.mjs scripts/update-security.test.mjs
node scripts/check-public.mjs
node --test scripts/check-dashboard.test.mjs
node scripts/check-dashboard.mjs
```

Check each Node project:

```bash
cd control-plane
npm run typecheck        # tsc --noEmit
npm test                 # manifest, archive and HTTP/security regressions
npm run build            # esbuild bundle, must stay a single file
cd ../gate
npm run typecheck && npm test && npm run build
cd ../templates/app-template
npm run typecheck && npm test && npm run build
```

Run the remaining commands from the repository root.

Database scenarios require a disposable PostgreSQL database named `*_audit`:
set `NANODEPLOY_TEST_DATABASE_URL` before `npm test`. The suite starts a real
gate instance and creates its own temporary test database. With gate's
dependencies installed, these cases also run in CI. Docker sandbox tests are
enabled separately with `NANODEPLOY_SECURITY_DOCKER=1`; they create and remove
only their own containers and networks. To exercise database restoration, set
`NANODEPLOY_TEST_POSTGRES_CONTAINER` to the disposable PostgreSQL container.
Set `NANODEPLOY_TEST_CADDY_IMAGE` to an image containing the Sablier plugin
to enable the Caddy routing tests.

The complete security suite provisions its own PostgreSQL, Caddy, Sablier,
builders and networks and cleans them up. It never reads `.env` or uses a live
installation database. Run it from the repository root after installing both
the control-plane and gate dependencies:

```bash
node scripts/security-check.mjs
```

It downloads test images and builds Caddy. To reuse a previously built test
image, set `NANODEPLOY_TEST_CADDY_IMAGE`.
The script pulls the pinned Node, PostgreSQL, HAProxy and Sablier images itself.
Use disposable Docker resources; do not aim integration tests at a real
installation's database or network.

```bash
bash -n install.sh scripts/*.sh e2e/smoke.sh
docker compose config -q     # needs a .env, even a dummy one
```

The end-to-end test needs a running installation:

```bash
NANODEPLOY_BASE=http://127.0.0.1:8080 \
NANODEPLOY_TOKEN=... \
APPS_DOMAIN=apps.example.com \
./e2e/smoke.sh
```

It deploys a throwaway app named `smoke`, exercises sleep, wake, prune,
reconcile and delete, then cleans up after itself.

For interface work, start a local preview with in-memory fixtures:

```bash
node scripts/preview-ui.mjs   # http://127.0.0.1:4173
```

This preview does not connect to Docker, Postgres, identity providers or a live
installation. Its data resets when the process restarts. Override the port with
`UI_PREVIEW_PORT` if needed.

The browser regression tests start their own fixture server and isolated browser
session. They require Node.js and the `agent-browser` CLI, resolved through `npx`:

```bash
node --test e2e/ui.test.mjs
```

They cover search and filters, app navigation, unsaved settings, deployment review,
permissions, invitations, Git setup, error states, mobile layouts and accessibility.

The CI also exercises a fresh `./install.sh --local`, first administrator
onboarding, a template deployment with a note surviving sleep, and the platform
smoke test on disposable x86-64 and ARM64 runners. Its local-mode
settings must never be used for a public installation.

To scan the complete Git history for secrets without an action license or a
service account:

```bash
docker run --rm --network none -v "$PWD:/path:ro" \
  ghcr.io/gitleaks/gitleaks:v8.30.1 git /path --log-opts=--all --redact --no-banner
```

The public-file check verifies relative documentation links and catches private
configuration/data files or absolute home-directory paths before publication.

## Style

- Comments in English, explaining a platform constraint or a non-obvious
  decision. Never restating the next line.
- The dashboard is a single self-contained HTML file with no build step and no
  dependencies. Keep it that way; both languages must stay in sync (`I18N.fr`
  and `I18N.en` have the same keys).
- API responses are language-neutral English. Wording for humans lives in the
  dashboard's translation tables.
