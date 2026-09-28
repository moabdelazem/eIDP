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

Light is the only theme in use — `<html>` carries no `dark` class. The `.dark`
token block in `src/index.css` is kept and works, but nothing switches to it
yet. Design and check against light.

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

`services/requests.ts` owns the lifecycle: pending → approved → completed or
failed, or pending → rejected or cancelled. Rows are never deleted; the row is
the history.

The rules that matter, each tested in `routes/requests.test.ts`:

- **Only the approver group decides**, and it is checked against the directory
  at the moment of deciding — `isApprover` in `integrations/ldap/groups.ts`.
  The `approver` role in the JWT is a UI hint only: a role in a token outlives
  a removal from the group by up to eight hours.
- **Nobody decides their own request.** A DEVOPS member's request needs a
  second DEVOPS member, or approval means nothing for exactly the people who
  can grant it.
- **Approval claims the row** with `update … where status = 'pending'`. Two
  approvers clicking at once produce one update and one creation.
- **One open request per target** is a partial unique index, not app code, so
  two people cannot race into asking for the same repository.
- **Creation runs after the approve call returns.** A project can take a minute
  in ADO. `recoverInterrupted()` at boot fails anything left `approved`, which
  only a restart mid-creation can leave behind — see its `ponytail:` note
  before running more than one API process.
- **ADO project creation is asynchronous.** The POST returns a queued
  operation; `createProject` polls it to the end rather than reporting success
  for something the server might still fail to create.

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

## DevOps-only access

Some pages and actions belong to the DevOps team (`APPROVER_GROUP`) alone.
Three layers enforce it, and only the last one is security — the other two keep
the UI honest:

1. **Sidebar** — `components/sidebar/nav-devops.tsx` renders the DevOps group,
   below a separator, only once the directory confirms membership.
2. **Route** — `app/require-devops.tsx` wraps those routes, so opening one by
   link shows a refusal and nothing behind it mounts or fetches.
3. **API** — `requireDevOps` in `middleware/auth.ts` on every DevOps-only
   endpoint. This is the one that actually protects anything.

Every layer asks the directory, live. None trusts the token's `roles` claim:
a validly signed token claiming `approver` for someone outside DevOps gets 403
everywhere, which `routes/rbac.test.ts` checks.

**Adding an admin page means four edits, or it leaks:** the item in
`devopsItems` (`app/nav.ts`), its route inside `<RequireDevOps>`
(`app/routes.tsx`), `requireDevOps` on its API endpoints, and those endpoints
in the `DEVOPS_ONLY` list in `routes/rbac.test.ts`. `grep -rn requireDevOps
apps/api/src/routes` lists the whole admin surface.

`POST /catalog/sync` is DevOps-only: a sync clones from Azure DevOps with the
service account's token and rewrites the catalog.

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
- **The map's search lives in the URL** (`/?q=`), so links land on a filtered
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

Test users live in `ldap/seed.ldif` (alice/alicepw, bob/bobpw, carol/carolpw;
alice and carol are in the DEVOPS group), mounted into
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
