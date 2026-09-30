# e-IDP

Internal developer portal: a project map sourced from the `inventories` repo, plus
self-service requests (create repo, create pipeline, request repo access).
See README.md for the product shape.

## Layout

pnpm workspace. `apps/*` and `packages/*`.

- `apps/api` — Hono API (`@eidp/api`), layered by concern:

  | Folder | Holds | Rule |
  |---|---|---|
  | `routes/` | HTTP shape: paths, validation, status codes | No business logic, no direct integration calls beyond one service |
  | `services/` | Logic that spans integrations | Knows nothing about HTTP |
  | `integrations/<name>/` | One outside system, one folder | `index.ts` is the only entry point others import |
  | `middleware/` | Cross-cutting request handling | Owns `AppEnv`, the typed context |
  | `lib/` | Config, errors, validation | No feature knowledge |

  `app.ts` builds the app without listening so tests drive it via
  `app.request()`; `index.ts` only serves it. Adding an integration means a new
  folder under `integrations/` and a route module — nothing else moves.
- `apps/web` — Vite + React UI (`@eidp/web`), organized by feature. Dev server
  proxies `/api` to the API on :3000.

  | Folder | Holds | Rule |
  |---|---|---|
  | `app/` | Providers, route table, shell, nav config | The only place routes are declared |
  | `features/<name>/` | One feature's pages, data access and state | Never imports another feature's internals |
  | `components/sidebar/` | `app-sidebar` plus one file per nav group | A new group is a new file mounted in `app-sidebar`, not a branch |

  `SidebarSeparator` between groups needs `w-auto!` — `separator.tsx` sets
  `data-[orientation=horizontal]:w-full`, which out-specifies the sidebar's own
  `w-auto`, so it renders full width plus `mx-2` and spills out of the rail.
  | `components/` | Shared app chrome (`empty-state`) | Used by two or more features |
  | `components/ui/` | shadcn primitives | Generated — regenerate, don't hand-edit |
  | `lib/` | `api-client`, `token-store` | No React, no feature knowledge |

  Routes live in `app/routes.tsx`; `RequireSession` guards everything behind it
  and remembers where you were headed. `app/nav.ts` is the single source for
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

## Stack

- Node 24 — runs `.ts` directly via native type stripping. No tsx, no build
  step, no ts-node. `erasableSyntaxOnly` is on: no enums, no parameter
  properties, no namespaces.
- Hono + `@hono/node-server`. Zod for env and request validation.
  `lib/config.ts` parses `process.env` once at boot, so a missing variable
  fails immediately with a readable message — read config from there, never
  `process.env` directly. Routes use `lib/validate.ts`, not `zValidator`, so
  every failure has the same shape: `{ error: { code, message } }`. Throw
  `ApiError(status, code, message)` for expected failures; anything else that
  escapes becomes a 500 with no detail leaked.
- React 19, React Router (declarative mode), Vite, Tailwind v4 (`@tailwindcss/vite`, no config file — tokens
  live in `src/index.css`), shadcn/ui new-york. shadcn 4.x imports `cn` from
  the `cn` package and Radix from the unified `radix-ui` package, so there is
  no `src/lib/utils.ts`.
- Postgres 17 and OpenLDAP via `compose.yaml`. Creds in `.env.example`.
  LDAP base DN is `dc=eidp,dc=local`.

## Design

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

Light is the only theme in use — `<html>` carries no `dark` class. The `.dark`
token block in `src/index.css` is kept and works, but nothing switches to it
yet. Design and check against light.

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

## Integrations

`integrations/ado/` — Azure DevOps **Server** (on-prem), not Services. URLs are
`<base>/<project>/_apis/<area>?api-version=<version>`, where `ADO_BASE_URL`
already carries the collection and the api-version is pinned to the server
release. A PAT authenticates as an empty username. ADO settings are optional so
the API boots without them; `adoConfig()` names what is missing when something
asks it to work.

Reading the ~1100 applications over the Items API would be thousands of calls,
so `git.ts` keeps a shallow working copy instead: clone once, fetch after. The
token goes in through `GIT_CONFIG_*` environment variables — command-line
arguments are world-readable in `ps`, a process environment is not.

`integrations/jira/` — Jira **Data Center / Server** (on-prem), REST v2 at
`<JIRA_BASE_URL>/rest/api/2/...`; v3 is Cloud's. `JIRA_TOKEN` is a personal
access token sent as Bearer; with `JIRA_USERNAME` set it is sent as that
user's password instead (Basic), for servers older than PATs. Optional like
ADO — `jiraConfig()` names what is missing. `fake-server.ts` stands in for it
(`pnpm --filter @eidp/api jira:fake`), including the ErrorCollection its
refusals use and an archived project whose key is still taken.

`integrations/inventories/` — parses that working copy into the catalog. Its
rules and the traps they exist for are in `parse.ts`; `__fixtures__/repo` is a
small tree covering both layout conventions, so the parser is tested without
network or checkout.

An application is **every variable file in its group_vars directory**, not
just `cicd.yml`: the technology file beside it (`dotnet.yml`, `Spring.yml`)
carries the images, ports, route, resources and replicas. They are merged the
way Ansible merges a group_vars directory — sorted by filename *by code point*,
later files replacing earlier top-level keys — so `dotnet.yml` overrides
`cicd.yml` but `Spring.yml` (capitals sort first) is overridden by it. Don't
"fix" that to `localeCompare`; it would stop matching what deployments get.

A **system** is read the same way: every file in `group_vars/all`, merged.
Ownership lives in `team.yml` there, beside `project.yml` — `<env>_team` for
each stage (stress and preprod included), `prd_approvers`,
`project_managers`, `ops_team_list`. Reading `project.yml` alone left every
system without teams, which also left team-scoped access bindings matching
nothing.

Reading is lenient because the repo is hand-maintained and Ansible is: a
duplicate key keeps the last value, and a file that still will not parse is
skipped and named in the sync's `warnings` rather than failing the whole
catalog. DevOps see those files listed under the map. Before this, one bad
file among ~4800 took the entire map down.

Secrets never leave the parser. Values under password/token/secret-like keys,
and inline `!vault` values, become `[hidden]` before anything is stored — the
portal shows configuration to people who may not have access to the repo.

Configuration is served per application (`GET /catalog/systems/:system/
applications/:name`), not with the catalog: 1100 descriptors on every map load
would be waste. An app without environment groups uses its base everywhere —
the page says "Uses the base", not "Not configured".

## Running it in containers

`scripts/dev.sh up` runs everything under podman in one pod: Postgres,
OpenLDAP, api and web. Because they share a network namespace, the app
containers reach the services on the *container* ports (5432, 389), not the
published host ports — the script passes `DATABASE_URL` and `LDAP_URL`
overrides that win over `.env`.

The api runs with `node --watch-path=src`, not `--watch`: `--watch` follows
individual files, and `git pull` replaces files rather than editing them, so
after a pull the api kept serving the old code — a new route answered as the
old `/:id` route's 404. Watching the directory catches replaced files. If an
api still looks stale, `scripts/dev.sh restart`.

`Containerfile.dev` installs dependencies into the image and only source is
bind-mounted, so the container never sees the host's `node_modules`. It also
installs `git`, which the catalog sync shells out to and the base image lacks.
`.containerignore` keeps `.env` out of the image layers.

## The catalog

`services/catalog.ts` owns it. `syncCatalog()` pulls the inventories checkout,
parses it and rebuilds the tables in one transaction — delete-then-insert,
because the catalog is derived data and readers keep the previous contents
until the commit lands. `catalog_sync` is a single row holding the outcome, so
the UI can tell current from stale from never-built.

The API never blocks boot on a sync and never fails to start because Azure
DevOps is unreachable: `index.ts` kicks the sync off in the background and the
state is reported through `/catalog`. Stale data is still served; only an empty
catalog is an error, and then the message carries the reason the last attempt
failed.

`lib/schema.sql` is applied at startup and is written to be re-runnable. There
is no migration tool — see the `ponytail:` note in `lib/db.ts` for when that
stops being enough.

## Requests

**Request types live in one registry**, `apps/web/src/features/requests/kinds.ts`,
grouped by provider (Azure DevOps, Jira, …). The sidebar's New request
dropdown, the same dropdown on My requests, the Ctrl/⌘ K palette, the routes,
the breadcrumbs and the form's title all read it. Paths are provider-scoped
(`/requests/new/azure-devops/project`) because an Azure DevOps project and a
Jira project are different things. A type with `kind: null` is listed as
"Soon" and disabled, and gets no route.

Adding a type: its registry entry, its form, and its API `kind` with an
executor in `services/requests.ts` — then flip `kind` from null. The sidebar
uses a dropdown rather than one item per type (shadcn's sidebar-06 pattern):
types will outgrow a flat list, and a dropdown is the only thing that still
works in the collapsed icon rail.

`services/requests.ts` owns the lifecycle: pending → approved → completed or
failed, or pending → rejected or cancelled. Rows are never deleted; the row is
the history.

The rules that matter, each tested in `routes/requests.test.ts`:

- **Only someone who may decide it decides**: `requests.decide` for anything,
  or `requests.decide_access` within its scope for an access request — see
  *Who may do what* below. Worked out from the directory and the bindings at
  the moment of deciding; the `roles` claim in the JWT is a UI hint only.
- **DEVOPS may decide their own requests.** This was once refused (a second
  member had to approve), and was dropped on purpose for speed; `decided_by`
  still records who approved what. Don't reintroduce it without asking.
- **Approval claims the row** with `update … where status = 'pending'`. Two
  approvers clicking at once produce one update and one creation.
- **One open creation per target** is a partial unique index, not app code, so
  two people cannot race into asking for the same repository. Access requests
  are excluded: several people asking for the same access is normal.
- **Creation runs after the approve call returns.** A project can take a minute
  in ADO. `recoverInterrupted()` at boot fails anything left `approved`, which
  only a restart mid-creation can leave behind — see its `ponytail:` note
  before running more than one API process.
- **ADO project creation is asynchronous.** The POST returns a queued
  operation; `createProject` polls it to the end rather than reporting success
  for something the server might still fail to create.

**Approval grants access, not just existence.** The requester and the team
they chose on the form — one of their own directory groups, checked live at
submit so nobody hands a repository to a group they are not in — get
Contributor: on a repository, an ACE in the Git namespace (read, contribute,
branch, tag, notes, pull requests; not force-push, policy exemption or
permission management); on a project, membership of `[Project]\Contributors`.
`integrations/ado/access.ts` finds each ADO identity by account name and
refuses to guess when a name matches nothing or two domains. Identities are
resolved *before* creating, so an unknown team fails with nothing made;
`result_url` is written the moment creation succeeds, so a retry after a
failed grant only grants. The ADO service account therefore needs Manage
permissions on repositories and the right to edit project group membership —
without them requests end `failed` with "Created X, but could not grant
access", and a retry finishes once that is fixed. Rows filed before teams
existed have `team_group` null and grant the requester alone.

**Jira projects** (`create_jira_project`) carry a name and a key and no
collection — `collection` is null on those rows and `project_key` is set, which
`requests_jira_check` enforces; two partial unique indexes keep one open
request per name and per key. `check()` asks Jira's own
`projectvalidate/key`, because the key pattern, its length and the reserved
words are server configuration, and only the server sees archived projects,
whose keys stay taken. Approval creates a `software` project from
`JIRA_PROJECT_TEMPLATE` (Scrum by default), led by the requester, then puts the
requester and their team in the `JIRA_MEMBER_ROLE` project role (Developers).
Same rules as ADO: both are found in Jira before anything is created,
`result_url` is written once the project exists, and `addToRole` adds only
actors not already in the role — Jira refuses the whole call if any one is,
which would make a retry fail forever. The service account needs Jira's
*Administer* global permission to create projects.

**Access requests** (`grant_access`) give up to 20 people, by login name,
Contribute on a whole existing project — membership of `[Project]\Contributors`.
Scope and level are fixed, not chosen: the API does not accept a repository or
a level for them and `submitGrant` stores `null` and `contribute` regardless.
Rows filed before that was fixed may carry a repository or Read, and
`executeGrant` still honours them (ACEs via `READER`/`CONTRIBUTOR` in
`access.ts`, or `[Project]\Readers`), so don't delete that branch while such
rows can be pending. `check()` confirms the project exists and that the
directory knows every name, so a typo is caught on the form rather than after
approval. Every name is resolved in ADO before anything is
granted, so one unknown name grants nobody rather than half the list, and a
retry just grants again — both operations are idempotent. The form is its own
page (`grant-access-page.tsx`); the badge says Granting/Granted, not
Creating/Created.

`check()` is what the form calls as someone types and what `submit()` runs, so
the two can never disagree. Name rules are in `request-rules.ts`, from the ADO
Server naming restrictions.

`integrations/ado/fake-server.ts` stands in for ADO Server in tests and local
development — including the sign-in page ADO returns instead of a 401, and the
queued operation behind project creation.

Group membership is found by `groupFilter()` in `integrations/ldap/groups.ts`.
An explicit `LDAP_GROUP_FILTER` wins; otherwise the server's rootDSE decides —
Active Directory gets the in-chain matching rule, because `memberOf` misses
nested groups, and OpenLDAP gets `groupOfNames`. It used to be a hardcoded
OpenLDAP default, and on AD that silently found no groups: nobody in DEVOPS
could approve anything. When the rootDSE is refused, an AD-style
`LDAP_USER_FILTER` is taken as the signal. The choice is pure
(`chooseGroupFilter`) so every branch is tested without an AD.

The UI decides whether to offer approvals from `GET /auth/profile`, read live
from the directory, not from the token's `roles` claim. A session that predates
a group change — or predates `roles` altogether — still shows the truth. The
profile page (`/me`) shows title, department, team (AD's `division`), manager
and groups, and when someone is not an approver it says what the directory
returned and how groups were looked up, rather than leaving them to guess.

Blank values in `.env` (`KEY=`) are treated as unset in `lib/config.ts`. Before
that, a `.env` copied from `.env.example` failed to boot on its blank
`ADO_PAT`.

## Who may do what

`services/rbac.ts` is the whole model, in three layers:

| Layer | What | Where |
|---|---|---|
| **Permission** | one thing the portal can do (`requests.decide`, `rbac.manage`, …) | `PERMISSIONS`, in code |
| **Role** | a named bundle of permissions (`member`, `team-lead`, `approver`, `devops-admin`) | `ROLES`, in code |
| **Binding** | a directory group or one user → a role, everywhere or limited to a `team` or `project` | `rbac_bindings`, managed on the Access page (`/access`) |

Two bindings are **built in** and are not rows: everyone is a `member`
(`catalog.view`, `requests.create` — anyone in AD can sign in and use the
portal), and `APPROVER_GROUP` is `devops-admin`. Being code, they cannot be
removed from the page, so nobody can lock the portal out of its own admin.

`accessOf(uid)` asks the directory for the person's groups (cached per process
for `GROUP_CACHE_MS`, a minute — a removal from a group lands within it) and
reads their bindings fresh on every check, so a change on the Access page
applies immediately. Expired bindings count for nothing. A binding whose role
has been deleted from code grants nothing and is listed on the page as such.

- **A grant to one person needs a reason**, and may carry an expiry. It is the
  replacement for the old portal's `VALID_USERS`; the group is the normal case.
- **Scope.** A `project` scope matches the ADO project by name. A `team` scope
  matches the owning teams the catalog read from each system's `project.yml`
  (`teamsOwning`), so a lead of `DEVJAVA` decides access to every project
  DEVJAVA owns in any environment. A scoped grant is never global.
- **Team leads decide access requests only.** Creating a repository or project
  stays with `requests.decide`. A lead's approvals queue (`listPool`) holds
  only what they may decide, and `GET /requests/:id` returns `canDecide` so the
  UI never has to guess at scope.
- **Every grant and removal is audited** (`rbac_audit`, append-only), and
  `GET /rbac/explain/:uid` answers "why can bob approve?" with the group or
  binding behind each permission. The RBAC tests make and remove bindings on
  `dave` only and delete their own audit rows, because they share the dev
  database with real use.
- **The old portal's map** (`VALID_GROUPS`/`VALID_USERS`) comes across with
  `pnpm --filter @eidp/api rbac:import rbac.py` — a dry run that prints what it
  would add and what it leaves out and why; `--apply` writes it. `X-Lead`
  becomes a `team-lead` binding scoped to team X; roles for features e-IDP does
  not have are left out rather than carried as dead names.

**Viewing as someone else** (`rbac.view_as`, DevOps admins): `POST
/auth/assume` returns a one-hour session as the target whose token carries an
`act` claim (RFC 8693's actor) naming the admin. `requireAuth` holds such a
session to two rules on every request: anything but GET/HEAD is refused
(`viewing_as`), and it dies (`view_as_revoked`, 401) the moment the admin no
longer holds `rbac.view_as`. It is read-only by design — seeing what someone
sees, never acting as them; a request form's live check is a POST, so forms
cannot even be submitted. Each use is audited (`rbac_audit.action = 'assume'`,
with `target`). The browser keeps the admin's own token aside
(`tokenStore.assume`); a 401 during a view returns to it instead of signing
out, and switching either way reloads from `/`, because every cached resource
belonged to the other identity. `ViewingAsBanner` stays across the top in red
the whole time.

Three layers enforce it, and only the last one is security:

1. **Sidebar** — `components/sidebar/nav-manage.tsx` lists each `manageItems`
   entry (`app/nav.ts`) only once the profile confirms its permission.
2. **Route** — `app/require-permission.tsx` wraps each path, so opening one by
   link shows a refusal and nothing behind it mounts or fetches.
3. **API** — `requirePermission(p)` in `middleware/auth.ts`; `{ scoped: true }`
   admits anyone holding it anywhere and leaves the per-item call to the
   service, which reads the caller's access through `accessFrom(c)`.

A validly signed token claiming `approver` for someone without the permission
gets 403 everywhere, which `routes/rbac.test.ts` checks.

**Adding a guarded page means four edits, or it leaks:** the item in
`manageItems` with its permission, its route inside a matching
`<RequirePermission>`, `requirePermission` on its API endpoints, and those
endpoints in the `DEVOPS_ONLY` list in `routes/rbac.test.ts`. A new capability
is a new entry in `PERMISSIONS` (and in `Permission` in
`features/auth/profile-context.tsx`), added to the roles that should hold it.
`grep -rn requirePermission apps/api/src/routes` lists the whole guarded
surface.

`POST /catalog/sync` needs `catalog.sync`: a sync clones from Azure DevOps with
the service account's token and rewrites the catalog. The map's **Refresh from
inventories** button (`refresh-catalog-button.tsx`, also on the map's
unavailable page) calls it and shows only to holders. `syncCatalog()` is
single-flight — a call while one runs joins it — because the timer and a click
can overlap, and two fetches into one checkout fight over git's lock.

## UI conventions

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

## Talking to the API

`lib/api-client.ts` is the only thing that calls `fetch`. It attaches the
session token, and turns a failure into an `ApiError` carrying the message the
API wrote — the UI shows that message rather than inventing its own wording for
a server-side outcome. A 401 clears the stored token, since a dead session is
dead everywhere.

## Auth

LDAP is the auth service. `integrations/ldap/` service-binds, searches for the
uid, then re-binds as that user's DN to verify the password — the uid is never
assumed to map to a DN pattern. `client.ts` owns connection handling: every
call goes through `withClient`, which always unbinds.

`POST /auth/login` returns an 8h HS256 JWT (`hono/jwt`, no extra dep);
`hono/jwt` middleware guards protected routes. `JWT_SECRET` is required at
boot.

The organization runs **Active Directory**, which `.env.example` is written
for. `ad-errors.ts` reads the sub-code AD buries in every bind rejection
(`... data 532 ...`): an expired password, a locked, disabled or expired
account and a logon restriction are each named to the person, because being
told "wrong password" when the account is locked makes people retry into a
longer lockout. `525` (no such user) and `52e` (wrong password) stay generic —
separating them would turn the login form into an account-name oracle.

Name and mail are read from the first attribute that has a value —
`displayName` then `cn`, `mail` then `userPrincipalName` — rather than
assuming one directory's schema.

The directory product is not assumed. `identify.ts` reads the rootDSE to name
the vendor and list its naming contexts, and the user filter is configurable —
`LDAP_USER_FILTER` as a `{username}` template when the two schema settings
cannot express what a directory needs. The username is escaped before
substitution, so a template cannot become an injection point.

A failed login has six distinct causes and they must not be conflated: the
directory being unreachable, the *service* account being rejected, a
`LDAP_BASE_DN` the server does not serve, the service account being denied the
search, no account matching the filter, and the user's own password being
wrong. Only the last is a 401 — the rest are 503s naming the setting at fault,
because a broken deployment must never be reported as the user's mistake.
`ldap:doctor` reports which one.

Test users live in `ldap/seed.ldif` (alice/alicepw, bob/bobpw, carol/carolpw,
dave/davepw; alice and carol are in DEVOPS, alice, bob and carol in Payments,
and dave in nothing — the RBAC tests bind roles to him), mounted into
the container's bootstrap dir so a fresh volume gets them. `pnpm --filter
@eidp/api test` runs against the live container.

## Commands

```sh
pnpm dev                           # .env + containers + both apps
pnpm test                          # all package tests
pnpm --filter @eidp/api dev        # watch mode
pnpm --filter @eidp/api typecheck  # tsc --noEmit
pnpm --filter @eidp/api test       # needs openldap up
pnpm --filter @eidp/web dev        # http://localhost:5173
pnpm --filter @eidp/web build      # tsc -b && vite build
docker compose up -d
```

## Notes

- `inventories` is read-only input. e-IDP never writes back to it.
- Don't add a dependency for something Node 24 or Hono already does.
