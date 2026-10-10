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

`/` is the Overview (`features/overview/`): headline tiles, two charts and
what is waiting on you. The map lives at `/map`; the old `/?q=` links
redirect there. Overview composes other features' public pieces and owns no
data. Its charts follow three rules: one series, one hue (`--chart-1`,
eggplant — never red), top 8 plus "Other"; every chart has an sr-only table;
and `charts.tsx` is lazy-loaded, because recharts is ~330 KB that only this
page needs — import nothing else from it statically, or it rejoins the main
bundle.

Motion explains a change and nothing more, and all of it lives inside
`prefers-reduced-motion: no-preference` (`index.css`), so reduced motion is
the default rather than an override. `page-enter` plays once per path, `reveal`
(opacity only — a transform would clobber an SVG node's position) fades in
new map nodes and timeline steps, and `lib/view-transition.ts` wraps a state
change in the native View Transitions API — a decided approval leaves and the
cards below slide up. No animation library.

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

`features/projects/catalog.ts` is placeholder data shaped to match what the
API's inventories parser produces — replace the rows, keep the types.
`tree.ts` turns a catalog into the map's node tree; `mind-map.tsx` lays it out
with `d3-hierarchy` and pans/zooms with `d3-zoom`, rendering plain SVG so it
inherits the theme. Links are hand-written cubic beziers rather than pulling
in `d3-shape` for one function.

The map prunes collapsed branches before layout, so a node's `children` is
gone while collapsed — `childCount` is carried alongside, or a collapsed node
looks like a leaf and loses its toggle. The map is a `role="tree"` of
focusable nodes, and the List view beside it is the plain, screen-reader
friendly path to the same data.

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
