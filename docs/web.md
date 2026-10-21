# The web app

How the UI is put together: routes and lazy pages, the Overview and its charts, motion, the projects map at scale, the sidebar, and how it talks to the API. Moved out of CLAUDE.md, which keeps the rules that break things and points here.

Routes live in `app/routes.tsx`; `RequireSession` guards everything behind it
and remembers where you were headed. Every page but the Overview and
sign-in is `lazyPage(() => import(…), 'Name')` (`app/lazy-page.ts`): its own
chunk, fetched when first opened, under one `Suspense` in `AppShell` that
shows a page skeleton. That took the main bundle from 914 KB to 403 KB. A
tab left open across a deploy asks for chunks that no longer exist, so a
failed load reloads once onto the new build (`eidp.chunk-reload` in
sessionStorage) and only a second failure in a row is an error. A new page
is added the same way — a static import puts it back in everyone's bundle. `app/nav.ts` is the single source for
sidebar items, split by what they do: `browseItems` for destinations,
`requestItems` for things people ask for. An item's `owns` prefixes keep its
section lit on detail pages.

The header shows a breadcrumb from `app/breadcrumbs.ts`, derived from the
pathname rather than route handles — `useMatches` needs a data router and we
use the declarative one. Each page renders exactly one `h1` in its content;
the header is the trail, not a heading.

**Coming back lands where you left** (`lib/places.ts`). The declarative router
restores no scroll, so the shell does it (`useScrollMemory`):
- a new page opens at the top; before this, a build opened from far down a
  list opened scrolled down;
- Back, Forward and a way-back link (state `BACK`) open where that address was
  left;
- a page's own filter change (a replace on the same path) does not move it.

Positions are kept per address in sessionStorage, the last 50. A restore waits
for a loading page to grow tall enough, up to two seconds, and stops the
moment someone scrolls. The current address is a ref, set before any scroll,
so the jump to a new page's top is never saved as the old page's position.

A list page calls `useRememberPlace()`, and the breadcrumb's way up goes to
`placeFor(path)`: that list as it was left. So "Jenkins" from a build lands on
the Builds tab, its window, search and page, not on a fresh Dashboard. Keep a
list's state (tab, filters, page, how many are listed) in its URL, or the way
back cannot bring it back. `rememberOpened`/`lastOpened` mark the item
someone opened last (the build lists show "Opened last"). All of it is per
browser tab, and degrades to memory without storage.

`/` is the Overview (`features/overview/`), made for whoever signs in. It
greets them by name and counts what needs them (pending decisions, failed
approved requests, their own requests rejected or failed this week, broken
pipelines, Jenkins failing, agents offline). Below that is a grid of cards.
`card-list.ts` decides which cards someone gets from what they may do:
Waiting on you needs `requests.decide_access` somewhere, Jenkins now needs
`jenkins.view`, and so on. The catalog charts start hidden for anyone without
`catalog.sync`. Your teams' projects matches the person's groups against the
inventories' `teams`. The order of the cards, and which are hidden, belong to
the person: Customize edits a draft, and Done saves it with the account
(`PUT /preferences/overview`, module `preferences`), so the Overview follows
them across browsers. `layout.ts` (`arrange`, tested) merges a saved layout
with the cards available today:
- a card new since saving goes in after the one it follows by default;
- a card no longer theirs drops out;
- Reset deletes the saved layout.

Each card reads under the same cache key as its full page
(`['requests','mine']`, `['pipelines','mine','7d']`, …), so the two share one
request. Each card draws inside its own `ErrorBoundary`.

The map lives at `/map`; the old `/?q=` links redirect there. The catalog
card's charts follow three rules:
- one series, one hue (`--chart-1`, eggplant, never red), top 8 plus "Other";
- every chart has an sr-only table;
- `charts.tsx` is lazy-loaded, because recharts is ~330 KB that only this page
  needs. Import nothing else from it statically, or it rejoins the main
  bundle (`import type` is fine).

**A render error must never blank the app.** React unmounts the whole tree
on an uncaught render error, so one unexpected value once took the portal
down from the Overview: a request kind this build did not know, written by a
newer branch sharing the database, made `KIND_ICON[kind]` undefined. Three
`ErrorBoundary`s (`components/error-boundary.tsx`) now contain such errors:
- one at the root, in `main.tsx`;
- one around the routed page in `AppShell`, which resets when the path
  changes, so the sidebar stays;
- one around each Overview card.

Boundaries keep the portal up, but a page that shows its error box is still
broken. The underlying rule is that a value from the API never indexes a
table without a fallback. TypeScript cannot catch this: the contract says
`kind` is one of four values, while the database or a newer API may hold a
fifth. The safe helpers fall back instead of returning undefined:
- `kindLabel`, `kindIcon`, `statusLabel` and `statusTone` in
  `features/requests/status.tsx`;
- `resultOf` in `features/jenkins/result.tsx`.

Anywhere else, use `?? fallback`, and give every `switch` on such a value a
`default` (the request page's tracker has one). An unknown value is shown by
its own name in the neutral style: never red, and never guessed as
something it is not. Index a `Record` directly only with a key you produced
yourself (`Object.keys(TABLE)`, a URL value already parsed to a known one).

The check for this: serve every page with each enum-like field in the API's
JSON rewritten to a value the build has never seen (a Playwright route over
`/api/**`). No page may show its error box. Nulls need no such check:
strict null checks already make the code handle every field the contracts
declare nullable.

Motion explains a change and nothing more, and all of it lives inside
`prefers-reduced-motion: no-preference` (`index.css`), so reduced motion is
the default rather than an override. `page-enter` plays once per path, `reveal`
(opacity only — a transform would clobber a node's position) fades in
new map cards and timeline steps, and `lib/view-transition.ts` wraps a state
change in the native View Transitions API — a decided approval leaves and the
cards below slide up.

What CSS cannot do is `motion` (`motion/react`), and only for a change
someone caused or is watching:
- a count rolling to its new value (`components/animated-number.tsx`; the
  first value is shown as it is, never counted up from zero, and the digits
  are written to an element React leaves empty, with the final value in an
  `sr-only` twin);
- the chosen stat tile's bar sliding to the next tile chosen (`StatTile`,
  one `layoutId` per row);
- a need arriving or leaving on the Overview, and a card sliding to its new
  place in Customize;
- a readiness tick landing in a request form's checklist, and the sign-in
  panel's map branch drawing itself once.

`app/providers.tsx` wraps the app in `LazyMotion strict` and
`MotionConfig reducedMotion="user"`: components use `m.*`, never `motion.*`,
and the features load in their own chunk after the first paint
(`lib/motion-features.ts`, ~28 KB gzipped) — the main bundle carries ~6 KB of
it. The count roll is a plain frame loop, not motion's `animate`, which would
put the animation engine back in the main bundle.

**The projects map** (`/map`, `features/projects/`) answers "where is it, who
owns it, where does it run" without leaving the page: a canvas of cards — the
organization, its systems, their applications with their technology and
environment pills — and a panel beside it for whatever is chosen (owners per
environment, the repository, what you can do: add an application, ask for
access, its builds, open it). With nothing chosen the panel says what the map
holds, each technology and environment a filter. The List view is the same
catalog as a card per system and a row per application, choosing into the same
panel; phones open on it, and there the panel rises as a sheet.

- `flow-map.tsx` is the canvas: React Flow (`@xyflow/react`, shared with the
  build page's stage graph, lazy-loaded so a phone on the list never fetches
  it), laid out by `d3-hierarchy` as a tree read left to right, with
  `onlyRenderVisibleElements`. Its cards are buttons; React Flow switches
  pointer events off on a node that is neither draggable nor selectable, so
  the canvas passes a no-op `onNodeClick` — without it nothing on the map can
  be clicked. Choosing a card selects it, and a closed system opens too; the
  round button on a card's edge opens or closes without choosing. Opening a
  branch by hand pans (never zooms) just enough to show it and its children.
  The line from the root to what is chosen is drawn in the ring colour.
- `tree.ts` is the model, tested in `tree.test.ts`: `filterSystems` (what the
  filters keep — the map and the list both read it), `buildTree`, `pathTo`,
  `resolve`. Ids carry their kind, and an application's is scoped by its
  system (`app:<system>/<name>`): an application's own id is its name, which
  two systems may share.
- `map-panel.tsx`, `map-list.tsx`, `map-toolbar.tsx` and `map-parts.tsx`
  (environment pills, the technology tag, search highlighting) are the rest.
  Production (`prd`, `prd_dr`) is marked by an eggplant dot, never red.

The map has to work at ~207 systems and ~1100 applications. Three rules keep
it usable there, and breaking any one of them makes it unusable again:

- A flat root of 207 siblings is a 5000px column no one can scan, so above
  `BUCKET_THRESHOLD` systems are grouped by initial. Filtering removes the
  buckets, because a narrowed list does not need them.
- Filters and the expansion they imply are applied in **one** update. Set the
  expansion in an effect and the map measures the tree from the render
  before, then fits to the wrong shape.
- Auto-fit refuses to shrink below `MIN_READABLE`. A result that technically
  fits but renders at 6px is worse than one you pan through. The fit button
  overrides it, because asking for the whole shape is explicit.

Open all and Close all refit as a filter does (they change the whole shape);
opening one branch does not, so the view never jumps from under the reader.

`features/projects/catalog.ts` holds the catalog's types as the map uses
them. The map prunes closed branches before layout, so a node's `children` is
gone while closed — `childCount` is carried alongside, or a closed system
looks like a leaf and loses its button. The List view is the plain,
screen-reader friendly path to the same data.

Sidebar links: hover (`--sidebar-hover`) is lighter than the current page
(`--sidebar-accent`), which also carries a lilac bar (`--sidebar-indicator`),
so where you are and where you point never look the same; colours fade in
180ms and the icon nudges on hover under `no-preference`. All of it is CSS
on `[data-sidebar=menu-button]` in `index.css`, not edits to the generated
`sidebar.tsx`, whose button animated only its size. A trigger whose menu
is open (New request) takes the hover tint, and its chevron leans out in
lilac.

Menu, palette (cmdk) and select items highlight in `--secondary` with dark
text, easing in 150ms — shadcn's own `bg-accent` is the rail's dark
eggplant here, which put the grey description under a highlight at 1.8:1 (now 5.4:1).
Menus, dialogs and popovers also drop their open animation under
`prefers-reduced-motion: reduce`, which shadcn does not do on its own.

The sidebar collapses to an icon rail
(`collapsible="icon"`), and `AppShell` reads the `sidebar_state` cookie back
itself — shadcn only writes it, since Next reads it server-side.

## Talking to the API

**The shapes are shared, not copied.** `packages/contracts/src/<area>.ts`
(requests, jenkins, pipelines, digest, activity, rbac, auth, chatbot, catalog)
holds the types of what each endpoint sends and takes. The API's services
declare their return types with them and re-export them under the names they
always had; routes that add a field (`canDecide`, a digest's `weeks`) say what
they send with `satisfies` (`RunDetail`, `DigestView`, `Profile`, `Catalogue`,
`Home`, `CatalogResponse`); the web's `features/*/api.ts` re-export them, with
local aliases where the web's name differs (`PortalRequest`, `MyRun`). Both
import them with `import type`, which Node's type stripping and Vite erase, so
the package is never loaded at run time and needs no build — but the dev image
copies its `package.json`, because the lockfile names it. Moving the copies
here found drift both ways: the web's pipeline queue items and application
configuration had lost fields, the API typed an explanation's category as any
string, and the web read `weeks` off a regenerated digest that has none.
`CATEGORIES`, `RUN_WINDOWS`, `WINDOWS`, `GROUPS` and `PERMISSIONS` are checked
against the contract's unions, so a value added on one side alone fails to
compile. Not Hono's `hc<AppType>`: `app.ts` mounts routes as statements, so
`AppType` carries no routes, and the web would type-check the API's Node code.
A contract file imports nothing from outside the package and holds no values.

**Reads go through one cache** (`@tanstack/react-query`, `lib/query-client.ts`).
`useResource(key, fetcher, { pollMs })` is the only way a component loads
data: the key names what is fetched and carries everything it depends on,
so the same key in two components is one request and one answer — the
sidebar's approvals badge, the Overview and the Approvals page share
`['requests', 'pool']`, and a reload in one refreshes all. A fetch that is
skipped under a condition uses its own `'none'` key, so the real answer
stays shareable. While a new key loads, the last one's data stays on screen
(`loading` says so). Five seconds fresh; a 4xx or this API's own 503 is an
answer and never retried, an unreachable portal or a proxy's 502/504 is
tried once. Every change of session empties the cache (`tokenStore.onChange`),
so one person's data never shows for the next. Writes still call the API
and then `reload`.

`lib/api-client.ts` is the only thing that calls `fetch`. It attaches the
session token, and turns a failure into an `ApiError` carrying the message the
API wrote — the UI shows that message rather than inventing its own wording for
a server-side outcome. A 401 clears the stored token, since a dead session is
dead everywhere.
