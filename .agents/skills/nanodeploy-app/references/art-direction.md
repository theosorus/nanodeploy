# Art direction

## Contents
- Why this step exists
- Offer three directions
- Avoid the three default looks
- Restate the choice in five lines
- What theme.css must define
- Self-hosted fonts
- Applying the direction
- The quality floor

## Why this step exists

The user is not only buying a working app, but one that looks like someone
decided how it should look. Skip this step and the result looks like every
other generated app. It happens before any code, and a direction chosen after
the fact turns into decoration.

## Offer three directions

Derive them from the **subject of the app**, not from a house style. A gym
log, a wine cellar, a reading list and a server monitor must not get the same
three options. Look at the objects, instruments, documents and vocabulary of
the subject's world.

Each direction gets:

- a **name**, one word from the subject's world;
- **one line** saying what it looks like;
- differences from the other two in **more than colour**: density, type
  treatment, how structure is shown (rules, cards, whitespace, numbering).

Example, for a climbing log:

```
1. Topo: a guidebook route diagram. Pale stone ground, thin dark line work,
   grades as small coloured tags, condensed sans, dense two-column lists.
2. Logbook: a paper training diary. Ruled rows, a serif for entries, tabular
   figures for totals, generous margins, one session per page.
3. Gear tag: the colour-coded tags on climbing gear. Saturated grade colours,
   rounded tags, large type, loose spacing, one card per session.
```

Ask the user to pick one and adjust it. If they say "you choose", choose the
one that fits the subject best and say why in one sentence.

## Avoid the three default looks

Generated design currently falls into three looks, whatever the subject:

1. warm cream background near `#F4F1EA`, high-contrast serif display,
   terracotta accent;
2. near-black background with one acid-green or vermilion accent;
3. broadsheet layout, hairline rules, zero border radius, dense columns.

Each is right when the subject calls for it. None is a choice when it arrives
by default. Before offering, check your three: if one lands on a default
without the subject demanding it, replace it and say why.

## Restate the choice in five lines

Once the user picks, write exactly this before any code:

```
Direction: <name>
Colour: <ground, text, accent, and what the accent is reserved for>
Type: <display face, body face, scale feel (dense / airy)>
Shape: <radius, line weight, depth (rules, borders or shadows)>
Signature: <the one element the app is remembered by>
```

## What theme.css must define

`src/styles.css` is shared by every app and never edited: spacing, type
scale, control sizes, focus ring, states, reduced motion. It reads these
variables, which **`src/theme.css` must define** in `:root`:

| Variable | Used for |
|---|---|
| `--bg` | Page background |
| `--fg` | Text |
| `--field` | Input background |
| `--muted` | Secondary text, placeholders, empty and waking states |
| `--line` | Borders and rules |
| `--accent` | Primary button, hover, focus ring |
| `--accent-ink` | Text on the accent |
| `--danger` | Error text |
| `--line-width` | Border thickness, e.g. `1px` |
| `--radius` | Corner radius of controls |
| `--font-display` | Headings |
| `--font-body` | Body text |
| `--font-mono` | `.num` figures and code |

It may also override `--t-base` (base font size, default 15px, the whole type
scale follows), `--measure`, `--line-body`, `--motion` and `--ease`. Set
`color-scheme` in `theme.css` and the matching `<meta name="color-scheme">`
in `index.html`.

Rewrite `theme.css` completely for each app, starting from its comment block:
say which direction it implements. Copying another app's theme ships the same
app twice. Add classes for the signature element in `theme.css` too.

## Self-hosted fonts

A typeface is where most of the personality lives. For anything that should
feel finished, self-host one or two `.woff2` files with an open licence (for
example from the Google Fonts or Fontsource catalogues, downloaded once):

1. Put the file in `public/fonts/` (create the folder). Vite copies it to
   `dist/fonts/`.
2. Declare it in `theme.css`:

```css
@font-face {
  font-family: "Display";
  src: url("/fonts/display.woff2") format("woff2");
  font-weight: 400 800;
  font-display: swap;
}
:root { --font-display: "Display", system-ui, sans-serif; }
```

3. Keep the licence file next to the font.

Never link a font or a stylesheet from a CDN (`fonts.googleapis.com` and the
like): the app must work without third parties and must not hand its visitors
to someone else's analytics. doctor refuses it. If you cannot download a font
file in your environment, use a well-chosen system stack and say so.

## Applying the direction

- **Typography carries the personality.** Choose display and body faces on
  purpose, set `--t-base` for the density, use weight and spacing
  deliberately.
- **Spend boldness in one place**: the signature. Keep everything around it
  quiet. Then remove one thing.
- **Structure must mean something.** Numbers, eyebrows and dividers only when
  the content is a sequence or a hierarchy.
- **Match the effort to the direction.** A dense direction needs precise
  alignment; a spare one needs precise spacing.
- **Write the words as carefully as the layout.** Buttons name what happens,
  one action keeps one word, errors say what to do, an empty screen invites
  the first action.
- **Changing an existing app?** Read its `theme.css` first and stay inside its
  direction. Never quietly restyle an app.

## The quality floor

Whatever the direction:

- usable at 375 px wide, no horizontal scroll;
- controls at least 44 px tall (`styles.css` does it; do not shrink them);
- visible keyboard focus (never remove the `:focus-visible` outline);
- `prefers-reduced-motion` respected (`styles.css` does it);
- text contrast of at least 4.5:1 against its background, 3:1 for large text;
- every interactive element reachable and usable by keyboard.
