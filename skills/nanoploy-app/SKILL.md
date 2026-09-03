---
name: nanoploy-app
description: Builds and deploys web apps on Nanoploy, a self-hosted platform (small ARM box, scale-to-zero, shared Postgres, gateway authentication). Use this skill AS SOON AS the user asks to create, code, scaffold, change or deploy an app, an internal tool, a dashboard, a tracker, a mini SaaS or "something that does X" meant for their own server, even without the word Nanoploy. Also triggers on "deploy this", "put this on my server", "build me an app for...", "add a page to my app", "fais-moi une app pour...", "mets ça sur mon serveur", or any mention of app.yaml, the control plane, Sablier, or the Nanoploy template. When in doubt about where a web app is meant to run, ask whether it is for Nanoploy rather than scaffolding something generic.
---

# Nanoploy app

Nanoploy deploys apps on a small home server, typically 4 GB of RAM. The
platform imposes one stack and a few hard constraints. An app that ignores them
deploys fine, then breaks silently after its first sleep.

Two things decide whether the result is any good: the platform rules below, and
the art direction. Skipping the second produces a working app that looks like
every other app an AI has ever generated. Do not skip it.

## Start by framing, in one round

Before writing a line, ask the user one grouped set of questions. One round, not
a drip feed. Then build, stating the assumptions you made for anything they left
open.

Ask about:

1. **Purpose and users.** What is it for, who opens it, only them or other
   people too. This decides the access mode and whether rows need an owner.
2. **Data and lifetime.** Which entities, which fields, what must survive, what
   can be lost. Changing this later means a migration.
3. **Access.** Private, restricted to a group, or public on the internet.
   `private` is the default. Never choose `public` on your own; if they ask for
   it, say plainly that the app will be open to the whole internet.
4. **Platform constraints that change the design.** Anything periodic, real
   time, large-file, or calling a paid external API. Each one forces a different
   shape, and some force `idle.warm: true`.
5. **Art direction.** See below. Offer three named directions and let them pick.

If the request already answers a question, do not ask it again. If the request
answers everything, skip straight to the art direction, which is never
answered by default.

## Art direction

The user is not buying a working app, they are buying an app that looks like
someone decided how it should look. Derive the direction from the subject, not
from a house style.

**Offer three named directions, derived from this app's subject.** One line
each, contrasted on more than colour: they should differ in density, in type
treatment, in how structure is expressed. Name them with a word from the
subject's world. The user picks one and adjusts it; you then restate the chosen
direction in five lines before writing any code.

Derive them from the material the app is about. A gym log, a wine cellar, a
reading list and a server monitor should not receive the same three options. The
subject's own artifacts, instruments and vocabulary are where a real direction
comes from.

**Check every direction against the defaults before offering it.** AI-generated
design currently clusters around three looks, and they show up whatever the
subject:

- warm cream background near `#F4F1EA`, high-contrast serif display, terracotta
  accent;
- near-black background, one acid-green or vermilion accent;
- broadsheet layout, hairline rules, zero border radius, dense columns.

Each is legitimate for a brief that calls for it. None is a choice when it
arrives by default. If one of your three directions lands there without the
subject demanding it, replace it and say why.

Then, while building:

- **Typography carries the personality.** Pick a display face and a body face on
  purpose, set a real scale, use weight and spacing deliberately. Self-hosting a
  `.woff2` is expected for anything that should feel finished: put the file next
  to the app and declare `@font-face` in `theme.css`. Never load a font from a
  third-party CDN: the app must keep working on a home server, and it must not
  leak its visitors to someone else's analytics.
- **Spend boldness in one place.** Pick a single signature element that the app
  is remembered by, and keep everything around it quiet. Then remove one thing.
- **Structure must mean something.** Numbered markers, eyebrows and dividers
  earn their place only when the content really is a sequence or a hierarchy.
- **Match effort to the direction.** A dense direction needs precision in
  alignment; a spare one needs precision in spacing. Elegance is executing the
  chosen direction well, not adding to it.
- **Write the words as carefully as the layout.** Buttons name what happens
  ("Ajouter", not "Soumettre"), an action keeps the same word through the whole
  flow, errors say what went wrong and what to do, an empty screen invites the
  first action. Generic copy makes a design feel templated as fast as generic
  colour does.

## What every app shares, and what it does not

`src/styles.css` is the shared rhythm: spacing scale, type scale, interaction
states, focus rings, reduced motion, responsive floor. **Use it unchanged in
every app.** It holds no colour, no typeface and no shape.

`src/theme.css` is the art direction: colours, faces, radius, line weight,
density, the signature. **Rewrite it entirely for every app.** Copying an app
and keeping its theme means shipping the same app twice.

Two apps on the same server should look nothing alike and still feel built by
the same hand. That is the split.

Quality floor, never negotiable, regardless of direction: usable down to
375 px, visible keyboard focus, `prefers-reduced-motion` respected, real text
contrast, controls at least 44 px tall, every interactive element reachable by
keyboard.

## The stack, non-negotiable

| Layer | Choice |
|---|---|
| Frontend | Vite + React + TypeScript, built to static files in `dist/` |
| Backend | Hono on Node 20, bundled by esbuild into a single `server.js` |
| Database | shared Postgres, accessed through Drizzle ORM |
| Auth | not a single line in the app, the gateway injects the identity |
| API routes | everything under `/api/*`, the rest is served statically by Caddy |
| API calls | always through `src/client.ts`, never a bare `fetch` |

Never propose Next.js, Express, Prisma, Mongo, NextAuth, Passport, Redis or a
different ORM. Each breaks a part of the platform. Tailwind is not used either:
the split between shared rhythm and per-app theme is the design system.

## The six scale-to-zero constraints

The container is stopped after `idle.timeout` and restarted on the first
request. So, in the code you generate:

1. **No in-memory state.** No local cache, no session in RAM, no global counter,
   no Map shared between requests. Everything goes to the database.
2. **No `setInterval`, no long `setTimeout`, no internal cron.** A sleeping app
   runs nothing. If a periodic task is genuinely required, say so and set
   `idle.warm: true`, explaining that the app will then run permanently for
   about 40 MB.
3. **No websockets.** Waking cuts the connection. Use polling, or SSE with
   automatic reconnection.
4. **Boot under a second.** No warm-up, no model loading, no migration at start.
5. **Postgres pool at `max: 3`.** The database is shared by every app and each
   connection is a forked backend process.
6. **Uploads go to `/data`, nowhere else.** The container filesystem is
   read-only; only `/data` (a dedicated persistent volume) and `/tmp` (16 MB,
   wiped on every wake) are writable.

A reboot is not a special case: an app asleep and an app killed by a power cut
are the same state. Code must survive being killed at any moment without losing
data, so write to the database before answering, not after.

## The API client

The first call that wakes a sleeping app is answered by Sablier's waiting page
(HTML) instead of the backend's JSON. The request never reached the server.
Every frontend call goes through `src/client.ts`, which detects that page and
retries. A bare `fetch` breaks silently on the first wake, especially on a POST.
Never bypass the client.

Use its `onWaking` hook to show a real "waking up" state. On a cold app the
first visit is the slow one, and a silent spinner reads as a broken app:

```typescript
api<Note[]>("/api/notes", undefined, { onWaking: () => setStatus("waking") });
```

## User identity

The app does not handle login. Caddy authenticates, then injects `Remote-Sub`,
`Remote-Email`, `Remote-Name` and `Remote-Groups`. Read them through
`server/auth.ts`, never by hand.

```typescript
const user = tryGetUser(c);   // null when the request carries no identity
```

An app switched to `public` from the dashboard receives no identity header at
all. Every route that needs a user therefore answers 401 when `tryGetUser`
returns null; that is what avoids a cascade of 500s. `getUser(c)`, which throws,
is only justified in an app that will always stay private.

Every user-owned table carries an `ownerId` column filled with `user.id`, and
**every read filters on it**. That filter is the entire authorisation model:
forget it once and one account reads another's rows. It is also what makes a
single account usable across every app.

Never create a `users` table, a login page, a signup form, password handling or
JWTs inside an app.

## Security rules for the code you write

The platform isolates apps from each other and from the host. It cannot protect
an app from itself.

- **Validate every input at the edge.** Check the type, then bound the length of
  every string. The body is whatever the network sent, not what the frontend
  meant to send.
- **Bound every query.** A `limit` on every list route. One shared 4 GB machine,
  no pagination, and one user with 50 000 rows is an outage.
- **Never build SQL by string concatenation.** Drizzle parameterises; if raw SQL
  is unavoidable, use the placeholder form.
- **Never render HTML from user input.** No `dangerouslySetInnerHTML`. React
  escapes by default; keep it that way.
- **Secrets are declared, never written down.** Put the name in `env` in the
  manifest, the user types the value in the dashboard. Never a key in the repo,
  never a key in the frontend bundle: everything in `dist/` is public even for a
  private app, since only the gateway stands in front of it.
- **Trust no client-supplied identity.** The only identity is the `Remote-*`
  headers, which the gateway strips from inbound requests and re-injects itself.
  Never accept a user id from a request body or a query string.
- **Check ownership on write, not just on read.** An update or a delete matches
  on both the row id and `ownerId`.
- **Outbound calls are a decision.** An app that calls an external API sends
  data off the machine. Say so, and keep the key server-side.

## The manifest

`app.yaml` at the root is the only contract with the platform.

```yaml
name: Suivi de dépenses
slug: depenses          # becomes depenses.<domain>, [a-z0-9-] only
                        # deploy, auth, id and www are reserved by the platform
access: private         # public | private | groups
groups: []
frontend: true
backend:
  entry: server.js
  port: 3000
database:
  enabled: true
  migrations: ./migrations
idle:
  timeout: 10m
  warm: false           # true only if the app must run continuously
env: [OPENAI_API_KEY]   # names only, values are typed in the dashboard
```

## Procedure

1. **Frame it.** The questions above, in one round.
2. **Copy the template.** `cp -r templates/app-template <slug>` from the Nanoploy
   repo, or reproduce its exact structure if the repo is not around.
3. **Write `app.yaml` first**, it frames everything else.
4. **Write `theme.css`**, the chosen art direction, before any component. Design
   decisions made after the fact turn into decoration.
5. **Define the schema** in `server/schema.ts` with Drizzle, `ownerId` included.
6. **Generate the migrations**: `npm run db:generate`. They are produced on the
   development machine, never on the server, and applied once at deploy time.
7. **Write the routes** in `server/index.ts`, all under `/api/*`, validated.
8. **Write the frontend** in `src/`, with no authentication logic, and with its
   loading, waking, empty and error states written from the start.
9. **Deploy**: `npm run deploy`. That builds the frontend, bundles the server,
   zips `dist/ server.js app.yaml migrations/` and posts it to the control
   plane. Needs `NANOPLOY_URL` and `NANOPLOY_TOKEN` in the environment.

After a successful deploy, give the URL and list the environment variables still
waiting for a value, if any.

## Changing an existing app

A deployment replaces the image and the container, but **never the database**. A
schema change therefore goes through a new migration: edit `server/schema.ts`,
run `npm run db:generate`, read the generated SQL, then deploy. Never edit a
migration that has already been deployed, and never drop a column without saying
so explicitly.

When changing an existing app, read its `theme.css` first and work inside its
direction. Do not quietly restyle an app that already has one.

## Before saying it is done

- [ ] no module-level variable mutated between two requests
- [ ] no timer, no cron, no websocket
- [ ] `max: 3` on the Postgres pool
- [ ] every route under `/api/*`
- [ ] every user-owned table filtered by `ownerId`, on reads and on writes
- [ ] every input type-checked and length-bounded, every list query limited
- [ ] no authentication code in the app
- [ ] every API call through `src/client.ts`
- [ ] loading, waking, empty and error states all written
- [ ] slug unique, lowercase, no underscore, not a reserved name
- [ ] secrets declared in `env`, never hardcoded, never in the frontend
- [ ] `theme.css` rewritten for this app, `styles.css` untouched
- [ ] usable at 375 px, keyboard focus visible, reduced motion respected

## Code style

Comments in English, explaining a platform constraint or a non-obvious decision,
never restating the next line. Interface language follows the user's, French by
default when they write in French. No comment that repeats the code.
