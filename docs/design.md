# Design

Colours, light and dark, brand marks, type and the logo. Moved out of CLAUDE.md, which keeps the rules that break things and points here.

Eggplant is the ground, red is the signal — if something is red it is an
action or it wants attention, never decoration. The app chrome (`--rail`)
stays dark eggplant; `--background` is paper. The shadcn `--sidebar-*`
tokens point at the rail, so the sidebar is the rail. `shadcn add` writes
its own neutral values into `src/index.css` — check them after adding any
component and point them back at the rail.

Three **meaning colours** sit beside those two, for state and nothing else:
`success` (green, done), `warning` (amber, waiting) and `info` (indigo, in
progress), each a text colour plus a `-soft` fill, all 4.5:1 or better in
both themes. `STATUS_TONE` in `features/requests/status.tsx` is where a
status gets its colour — badges, the stat tiles' dots and the timeline's last
step all read it. They never carry meaning alone: every one comes with an
icon and a word. Red still means only "act on this".

**Light and dark.** `next-themes` (already a shadcn dependency, for the
Toaster) puts `dark` on `<html>` — Light, Dark or Same as the system, from the
user menu at the foot of the rail, kept per browser in `eidp.theme`, the
system's by default. A dark page never flashes paper because of a small
script in `index.html` that sets the class before the first paint —
next-themes' own script is rendered by React, which never runs scripts it
renders. Every colour is a token with a value in both `:root` and `.dark`
(`src/index.css`); the rail is the one exception, identical in both. A new
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
DNs, pipeline ids) and nothing else.

`apps/web/src/assets/logo.png` is the logo the app uses: the supplied mark
with its baked `rgb(240,243,250)` background knocked out and the padding
trimmed, so it sits on the eggplant rail and on paper without a visible box.
`logo-source.png` beside it is the untouched original. Replacing the logo
means repeating that knockout, or supplying one with real transparency.
