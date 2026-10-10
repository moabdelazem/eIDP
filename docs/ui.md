# UI conventions

How pages are named, laid out and loaded; how identifiers wrap; dialogs; tables; DataView; the palette. Moved out of CLAUDE.md, which keeps the rules that break things and points here.

- **Every page names its tab** with `usePageTitle` (`lib/use-page-title.ts`),
  most specific part first — `agriland-scoring — e-IDP`. Approvals puts the
  pending count in front so DevOps can leave the tab open.
- **Requests lead with the name.** `RequestName` shows the repository or
  project name on its own line and the collection/project as context beneath.
  Leading with the collection pushed the name off the end of the line on a
  phone. In lists, status and time sit beside the name on wide screens and
  drop beneath it on narrow ones.
- **Identifiers wrap between segments, never inside one.** `TargetPath` and
  `WrappingUrl` break at `/`; nothing uses `break-all`, which split
  `Payments_Platform` into `Payments_Pl` / `atform`.
- **"DevOps" in prose.** `DEVOPS` is the AD group name; it appears only where
  the group itself is meant, on the profile and the access-denied page.
- **A Radix `Select` calls `onValueChange` while it settles on its first
  value.** A handler that resets other fields (a collection emptying its
  project) must ignore the value it already has, or it wipes what a link
  prefilled.
- **The map's search lives in the URL** (`/map?q=`), so links land on a filtered
  map and back/forward keep it. Phones open the map on the List view — a tree
  needs width a phone does not have.
- **`DataView` (`components/data-view.tsx`) shows any object as highlighted
  YAML or JSON**, with copy and download. shadcn has no code or syntax
  component — only a styled inline `<code>` — so it is built on Shiki, which
  uses the same grammars as VS Code. It is on the application page (every
  group directory keyed as in the repo), a request's data, and the profile.
  Shiki (core, JS regex engine, json and yaml grammars) and the `yaml`
  serialiser are dynamic imports in `lib/highlight.ts` and the component: none
  of it is in the main bundle, and a page without a viewer never loads it.
  Colours are `--shiki-*` variables in `index.css`, drawn from the palette —
  never red. Output goes in via `dangerouslySetInnerHTML`, which is safe only
  because Shiki escapes every token; keep it that way. The effect keys on the
  serialised text, not the `data` object, because callers build it inline.
- **Requests can be read as cards or as a table.** `RequestStats` is a row of
  counts per status; each tile is a filter. `RequestsTable` (shadcn `Table`)
  searches, filters, sorts and pages — in the browser, over what the API sent
  (see the `ponytail:` note there). My requests switches with `?view=table`;
  Approvals has Queue and History tabs (`?tab=history`), the history coming
  from `GET /requests/history`, scoped like the queue. Tiles and the table's
  status filter share `STATUS_NAME` ("Done"), which is not the badge's wording
  ("Created"/"Granted") on purpose: a filter names the state, not the kind.
- **Dialogs for two jobs, and only those.** An `AlertDialog`
  (`components/confirm-dialog.tsx`) before anything that acts outside the
  portal or cannot be undone — approving (`ApproveDialog` says what will be
  created and who will get access), withdrawing, removing a binding — and it
  stays open until the action settles, so a failure is not hidden by the close.
  A `Dialog` to glance without leaving the page — a request previewed from a
  table (`RequestPreview`), raw data (`DataDialog`), the files a sync skipped.
  Forms that are the page's purpose stay pages; retry and reject keep their
  own shape (reject already asks for a reason in a dialog).
- **Pages use the width.** `components/page-layout.tsx` holds the shapes:
  `PAGE` (the one width cap, shared with the Overview), `PageHeader`,
  `Split` (a main column plus a 20–22rem side column that stacks under it
  below `lg`), `Section` (a titled shadcn `Card`; `flush` for edge-to-edge
  lists) and `Facts` (label/value rows). Main column is what the page is
  for — the timeline, the queue, the configuration; the side column is facts
  and short lists about it. A page with its own `max-w-2xl` left the right
  third of a desktop empty; don't reintroduce one. `RequestRow` lays itself
  out with container queries (`@container`/`@md:`), not screen breakpoints,
  because the same row sits in a full-width list and in a side column.
- **A chart's table is inside an `sr-only` div**, never an `sr-only` table: a
  table ignores the 1px width, so the invisible table widened every chart page
  on a phone by its own width. `PageHeader`'s actions wrap (`min-w-0`, not
  `shrink-0`) for the same reason — three buttons ran off a phone screen.
- **Loading looks like what is loading.** `components/skeletons.tsx` has
  placeholders shaped like the real layouts (header, facts, request rows,
  approval cards, timeline, bar chart), each wrapped in `Loading` so screen
  readers hear one "Loading…" instead of a run of empty divs. Use them, not one
  big block. shadcn's `Skeleton` paints with `--accent` — dark eggplant here —
  so `index.css` repoints `[data-slot=skeleton]` at `--skeleton`, and stops its
  pulse under reduced motion.
- **Ctrl/⌘ K opens a jump-to palette** (`components/command-palette.tsx`)
  over applications, systems and pages. It filters itself and renders only the
  top matches, because cmdk's own filtering mounts every item — 1100 hidden
  rows per keystroke. DevOps pages are listed only to DevOps.
