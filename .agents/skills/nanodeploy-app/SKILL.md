---
name: nanodeploy-app
description: "Builds, changes and ships web apps for Nanodeploy, a self-hosted platform where apps sleep when idle, share one Postgres and get their users from a sign-in gateway. Covers the bundled app template, app.yaml, the code rules that keep a sleeping app working, and both ways to ship: a ZIP archive (built here, dropped on the dashboard or uploaded with a deploy key) or a GitHub/GitLab repository the server builds on every push. Use when the user wants to create, modify, fix or deploy a web app, internal tool, dashboard, tracker or mini SaaS for Nanodeploy or their own server, asks for a zip to deploy, wants to make a repository or existing project deployable on Nanodeploy, or mentions app.yaml, deploy keys (ndd_), Sablier or the app template. Not for installing or operating the platform itself: use nanodeploy-setup."
compatibility: "Needs Node.js 24+ and npm with access to the npm registry. Git deployments also need git, and the gh or glab CLI to open pull requests."
license: MIT
---

# Nanodeploy app

Nanodeploy runs small web apps on one self-hosted Linux server. Each app gets
`https://<slug>.<domain>`, a Postgres database and signed-in users. It is
stopped when nobody uses it and restarted by the next request. An app that
ignores this deploys fine, then breaks on its second visit.

This file says what to do and in which order. The details are in
`references/`. When a step says **Read**, open that file and read all of it
before doing the step. Do not fill gaps with habits from other platforms.

`SKILL_DIR` below means the folder that holds this SKILL.md.

## 1. Decide the task and the delivery mode

Answer both questions first, then tell the user your two answers in one line.

**Task**

| The user wants | Task | Read |
|---|---|---|
| a new app | **Create** | [references/build-the-app.md](references/build-the-app.md) |
| a change to an app already running on Nanodeploy | **Change** | [references/change-an-app.md](references/change-an-app.md) |
| an existing project (repository, folder, zip) to run on Nanodeploy | **Adapt** | [references/deploy-git.md](references/deploy-git.md), section "Adapt an existing project" |

**Delivery mode**: how the app reaches the server.

| Situation | Mode | Read |
|---|---|---|
| Nobody gave you a deploy key, or you cannot reach the server. **The default.** Always the case on claude.ai. | **ZIP hand-over**: you build, then give the user two zip files | [references/deploy-zip.md](references/deploy-zip.md) |
| The user gave you `NANODEPLOY_URL` and a deploy key `ndd_...` | **ZIP upload**: `npm run deploy` | [references/deploy-zip.md](references/deploy-zip.md) |
| The app is (or must be) in a GitHub or GitLab repository connected to Nanodeploy | **Git**: commit and push, the server builds | [references/deploy-git.md](references/deploy-git.md) |

If you hesitate between ZIP and Git, ask the user once. Never ship one app
both ways: a Git-connected app is replaced by its next push.

## 2. Learn the platform once

**Read [references/platform.md](references/platform.md)** before writing any
code in this conversation. It explains the request path, sleep and wake-up,
identity, the server-side container and its limits. Every rule below comes
from it. [references/manifest.md](references/manifest.md) is the full
`app.yaml` reference.

## 3. Create an app: the workflow

Copy this checklist into your reply and tick the boxes as you go. Do the steps
in this order. Do not skip one.

```
- [ ] 1. Frame the app with the user (one round of questions)
- [ ] 2. Art direction: three named directions, the user picks one
- [ ] 3. Copy the template, run npm ci
- [ ] 4. app.yaml: name, slug, access, roles, env
- [ ] 5. src/theme.css rewritten for the chosen direction
- [ ] 6. server/schema.ts, then npm run db:generate
- [ ] 7. server/index.ts: every route under /api/
- [ ] 8. src/: the interface, with loading, waking, empty and error states
- [ ] 9. npm run check until it reports 0 errors
- [ ] 10. Deliver with the mode chosen in section 1
- [ ] 11. Report to the user (section 6)
```

**Step 1. Frame.** Ask one grouped set of questions, in one message, then
wait. Skip a question the request already answers. Ask about:

1. Purpose and users: what it is for, who opens it (only them, family, a
   team, the whole internet).
2. Data: which things it stores, which fields, what must never be lost.
3. Access: `private` (accounts of the server, the default), `groups` (chosen
   groups), or `public` (anyone on the internet). Never pick `public` yourself.
   If they ask for it, say plainly that anyone on the internet can open it.
4. Constraints that change the design: anything periodic, real time, large
   files, or a paid external API.
5. The art direction (step 2), which no request answers by default.

If the user says "just build it", choose sensible answers, state them as
assumptions in one list, and go on.

**Step 2. Art direction.** **Read [references/art-direction.md](references/art-direction.md)**,
offer three named directions, let the user pick, then restate the choice in
five lines before writing code.

**Step 3. Copy the template.** The template ships inside this skill at
`SKILL_DIR/assets/app-template/` (in the Nanodeploy repository,
`templates/app-template/` is the same). Copy it to a new folder named after
the slug, outside `SKILL_DIR`. This command works on Linux, macOS and Windows:

```bash
node -e "require('fs').cpSync(process.argv[1], process.argv[2], { recursive: true })" "SKILL_DIR/assets/app-template" "./my-slug"
cd my-slug
npm ci
```

npm warnings about install scripts (esbuild) are harmless. Then **read
[references/build-the-app.md](references/build-the-app.md)** for steps 4 to 8.

**Step 9. Check.** Run `npm run check` (types, tests, build, then
`npm run doctor`). Read every `ERROR`, fix it, run it again. Continue only at
0 errors. Read each `WARN` and fix it unless you can say why it does not apply.

**Step 10. Deliver.** Follow the reference for your mode, completely.

## 4. Change or adapt an app

- **Change**: read [references/change-an-app.md](references/change-an-app.md)
  first. Get the current source before touching anything, keep the slug, and
  work inside the app's existing look.
- **Adapt**: read [references/deploy-git.md](references/deploy-git.md),
  section "Adapt an existing project", then
  [references/build-the-app.md](references/build-the-app.md) for the rules the
  code must follow.

When something fails, look up the exact message in
[references/troubleshooting.md](references/troubleshooting.md) before
guessing.

## 5. Rules that are never broken

Each one comes from how the platform works. Breaking it does not fail the
deploy; it breaks the app later, silently.

1. **Use the template's stack**: Vite + React + TypeScript, Hono on Node 24,
   Drizzle on the shared Postgres. No Next.js, Express, Prisma, Mongo, Redis,
   socket.io, Tailwind or auth library.
2. **Every API route is under `/api/`.** Caddy sends only `/api/*` to the
   backend; everything else is a file from `dist/`.
3. **Every frontend call to `/api` goes through `api()` from `src/client.ts`.**
   The first call after a sleep gets an HTML waiting page; `api()` retries it.
4. **No state in memory, no timers, no websockets, no cron.** The process is
   stopped at any moment. Everything that matters goes to Postgres first.
5. **No login code at all.** The gateway signs people in. Read the user with
   `tryGetUser(c)` from `server/auth.ts`; answer 401 when it returns null.
6. **Every user-owned table has `ownerId`, and every read, update and delete
   filters on it.** That filter is the whole authorisation model.
7. **Validate every input and bound every list** (type, length, `limit`).
8. **Secrets: names in `env` in app.yaml, values typed by the user in the
   dashboard.** Never in code, Git, the frontend or a zip.
9. **The server is one bundled file.** The image has no `node_modules`: no
   native packages (bcrypt, sharp, sqlite), no files read next to the code.
10. **Files go to `/data`**, the only persistent writable folder.
11. **Outbound calls: public HTTPS only**, through the platform proxy (Node's
    `fetch` does it). No SMTP, no LAN, no raw TCP.
12. **Schema changes are new migration files**, generated with
    `npm run db:generate`. Never edit or rename one that was deployed.

## 6. Report to the user

End every task with this report, in the user's language. Fill in what applies,
drop what does not.

```
What I built: <one sentence>
Assumptions: <list, or "none">
Delivery:
  ZIP hand-over: <slug>-deploy.zip (deploy) and <slug>-source.zip (keep it), plus the dashboard steps
  ZIP upload: live at <url>, version <n>
  Git: branch <b>, pull request <link>, preview <url> once the build is green
Still to do in the dashboard: <env values to type, roles to give, access to change>
Checks: npm run check passed (0 errors); warnings left on purpose: <list or none>
```

Never write "deployed" unless you saw the platform's answer saying so. Never
call it done while `npm run check` reports an error.

## 7. Style

Talk to the user in their language. Interface text follows the user's language.
Code comments in English, only where they explain a platform constraint or a
non-obvious decision.

## References

- [references/platform.md](references/platform.md): how Nanodeploy works, end to end
- [references/manifest.md](references/manifest.md): every `app.yaml` field, with rules and examples
- [references/build-the-app.md](references/build-the-app.md): writing the app from the template, file by file
- [references/art-direction.md](references/art-direction.md): choosing and applying a visual direction
- [references/deploy-zip.md](references/deploy-zip.md): ZIP hand-over and ZIP upload
- [references/deploy-git.md](references/deploy-git.md): Git deployments, previews, adapting an existing project
- [references/change-an-app.md](references/change-an-app.md): changing a live app, migrations, rollback
- [references/troubleshooting.md](references/troubleshooting.md): exact error messages, causes and fixes
- `assets/app-template/`: the app template, identical to `templates/app-template/` in the Nanodeploy repository
