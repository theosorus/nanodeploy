# Contributing

Nanodeploy targets one specific machine class: a single small ARM box with about
4 GB of RAM, at home, behind a tunnel. That constraint decides most arguments.

## Before you open a pull request

- **Keep the resting footprint down.** The whole platform idles under 200 MB.
  A change that adds a permanently running service needs to justify its RAM.
- **Keep the stack fixed.** One gateway, one identity provider, one Postgres,
  one control plane. Swapping a component is a fork, not a pull request.
- **Assume apps are hostile.** Anything reachable from `nanodeploy_apps` is
  reachable by arbitrary code. Read `SECURITY.md` before touching networking,
  the socket proxies, or the generated Caddy config.
- **Assume the machine loses power.** Every state change must survive a hard
  reboot: Postgres holds the truth, Docker and Caddy are rebuilt from it by the
  reconcile pass.

## Checks

```bash
cd control-plane
npm ci
npm run typecheck        # tsc --noEmit
npm run build            # esbuild bundle, must stay a single file
```

```bash
bash -n install.sh e2e/smoke.sh
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

## Style

- Comments in English, explaining a platform constraint or a non-obvious
  decision. Never restating the next line.
- The dashboard is a single self-contained HTML file with no build step and no
  dependencies. Keep it that way; both languages must stay in sync (`I18N.fr`
  and `I18N.en` have the same keys).
- API responses are language-neutral English. Wording for humans lives in the
  dashboard's translation tables.
