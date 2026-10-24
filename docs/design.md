# Design

Colours, light and dark, brand marks, type and the logo. Moved out of CLAUDE.md, which keeps the rules that break things and points here.

**Two palettes, chosen per person; Classic is the default.**

- **Classic**: an eggplant ground (`--rail` `#2a1930`) and a crimson signal
  (`#c4142b`). It is `:root` and `.dark` in `src/index.css`.
- **e-finance**: the e-finance mark's navy (`#003366`) on white, its red
  (`#E31E24`) as the signal, slate neutrals and a light rail. It is
  `data-palette="efinance"` on `<html>`, a block of overrides:
  `:root[data-palette='efinance']` outranks `:root` and `.dark`, and
  `:root.dark[data-palette='efinance']` outranks both. A token added to
  Classic needs its e-finance value in that block too, or e-finance quietly
  shows the Classic one.

e-finance was drawn from a shadcn token set, and departs from it only where
the rules below need it:

- `secondary` stays a light navy tint, not solid navy: the app uses it as a
  soft fill (hover rows, chips, step numbers) in dozens of places.
- In dark, red as text is a lighter step: `#E31E24` reads 3.8:1 on the dark
  card. `destructive` is that same red; the set's deep maroon read 1.8:1.
- The dark focus ring is blue, not red.
- The chart colour is navy, never red.

In both palettes, red is the signal. If something is red, it is an action or
it wants attention, never decoration. Every text pair is 4.5:1 or better, and
every ring or mark 3:1, in both themes. Check a new value with a contrast
tool before it lands.

**`accent` is a light tint of the ground, never the ground itself.** It is
what a menu item, a select option and a ghost button turn when pointed at. It
was once the dark navy (and the dark eggplant), which turned every hovered
item into a solid block.

The shadcn `--sidebar-*` tokens point at the rail (`--rail*`), so the sidebar
is the rail. `shadcn add` writes its own neutral values into
`src/index.css`, so check them after adding any component and point them
back at the rail.

The user menu's *Colours* picks the palette, beside *Theme* (light, dark,
system), so there are four looks in all. The menu's swatches are their own
tokens (`--swatch-*`), fixed whichever palette is in use.

**The choice is kept twice**, so it holds wherever the person signs in:

- **In the browser**: `eidp.palette` (`lib/palette.ts`) and `eidp.theme`
  (next-themes). index.html's script applies them before the first paint, so
  a page never flashes the other colours. `applyStoredPalette()` applies the
  palette again as the app starts, in case a policy against inline scripts
  stops that script.
- **With the account**: `GET`/`PUT /preferences/appearance`
  (`lib/appearance.ts`). The user menu saves every change there.
  `app/appearance-sync.tsx` reads it after sign-in, so another browser,
  another machine or cleared site data still looks the way the person left
  it. Someone who chose before this existed has their browser's choice saved
  as theirs on their next sign-in.
- **Not while viewing as someone else**: that session is read-only, and the
  admin keeps their own look.

Three **meaning colours** sit beside those two, for state and nothing else:
`success` (green, done), `warning` (amber, waiting) and `info` (teal, in
progress), each a text colour plus a `-soft` fill, all 4.5:1 or better in
both themes. `STATUS_TONE` in `features/requests/status.tsx` is where a
status gets its colour — badges, the stat tiles' dots and the timeline's last
step all read it. They never carry meaning alone: every one comes with an
icon and a word. Red still means only "act on this".

**A console log's colours are the tool's, not ours.** The 16 ANSI colours a
log asks for (Jenkins' AnsiColor) are tokens, `--ansi-0` … `--ansi-15`, each
re-read for its theme — a terminal's white would vanish on a white card, its
black on a dark one — and each 4.5:1 or better against the card. Beyond the
16, the xterm palette and true colour are drawn as the tool wrote them. A
tool's red is whatever it printed red; the viewer's own marks (an error
line's icon and tint) still follow the rule above. Syntax highlighting in the
log viewer uses DataView's `--shiki-token-*` colours, and the meaning colours
only for meanings: a log level, a result.

**Light and dark.** `next-themes` (already a shadcn dependency, for the
Toaster) puts `dark` on `<html>` — Light, Dark or Same as the system, from the
user menu at the foot of the rail, kept in `eidp.theme` and with the account
(above), the system's by default. A dark page never flashes paper because of a small
script in `index.html` that sets the class before the first paint —
next-themes' own script is rendered by React, which never runs scripts it
renders. Every colour is a token with a value in both `:root` and `.dark`
(`src/index.css`); Classic's rail is the one exception, identical in both. A new
colour needs both values, checked in both themes — a hex in a component is
how a dark page grows a white box. Brand marks take a `dark` shade where their
blue would sink into a dark card (Jira's #0052CC was 2.6:1).

Azure DevOps and Jira appear by their own marks (`components/brand-icons.tsx`,
paths from Simple Icons, CC0 — Lucide has no brand icons, and a package for
two paths is not worth it). They draw in their product blues by default, the
one place colour comes from outside the palette, because that is how people
recognise them; pass `tone="current"` where colour would be noise. Each
provider in `kinds.ts` carries its mark, so a new provider brings its own.
Jenkins is the exception: its brand colour is red, and red here means "act",
so `JenkinsIcon` defaults to the text colour.

The Jenkins **pipeline** request is listed as Soon (`kind: null`) — what it
does is still to be specified, so it has no form, route or API kind yet.

Archivo for UI, JetBrains Mono for identifiers the user can copy (repo paths,
DNs, pipeline ids) and nothing else. Both ship with the app
(`@fontsource-variable/*`, imported in `main.tsx`), not from Google Fonts: an
internal network often cannot reach it, and the portal quietly fell back to
the system font. Archivo is loaded with its width axis, and each page's one
`h1` is set wider (`font-stretch: 112%` in `index.css`), so a title reads as a
sign over the page; `font-display` (118%) is for the few large words that are
not an h1, the sign-in panel's. Only those: body text keeps the normal width.
Labels are sentence case — no all-caps eyebrows.

The Overview's greeting is the one loud thing in the portal: large, wide, the
date above and a live count of what needs you below, with a red dot that
pings three times (red because those are things to act on). Everything else
stays quiet.

`apps/web/src/assets/logo.png` is the logo the app uses: the supplied mark
with its baked `rgb(240,243,250)` background knocked out and the padding
trimmed, so it sits on either palette's rail and on paper without a visible box,
and scaled to 128 px — over three times the 36 px it is ever shown at, sharp on
a high-density screen, 7 KB instead of 21 on every first load.
`logo-source.png` beside it is the untouched original. Replacing the logo
means repeating that knockout, or supplying one with real transparency.
