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

Test users live in `ldap/seed.ldif` (alice/alicepw, bob/bobpw), mounted into
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
