# e-IDP

Internal developer portal: a project map sourced from the `inventories` repo, plus
self-service requests (create repo, create pipeline, request repo access).
See README.md for the product shape.

## Layout

pnpm workspace. `apps/*` and `packages/*`.

- `apps/api` — Hono API (`@eidp/api`), a modular monolith: one process, one
  database, split by business area into modules that only meet at their
  front doors.

  | Folder | Holds | Rule |
  |---|---|---|
  | `modules/<name>/` | One area: `access`, `activity`, `auth`, `catalog`, `chatbot`, `digest`, `health`, `jenkins`, `pipelines`, `requests` | Other modules import its `index.ts` and nothing else |
  | `modules/<name>/routes.ts` | HTTP shape: paths, validation, status codes | Mounted by `app.ts` alone; no business logic |
  | `modules/<name>/service.ts` (and its parts) | The area's logic | Knows nothing about HTTP |
  | `modules/<name>/jobs.ts` | The area's background jobs | Scheduled by `server.ts` from the index |
  | `integrations/<name>/` | One outside system, one folder | `index.ts` is the only entry point others import; knows no module |
  | `middleware/` | Cross-cutting request handling | Owns `AppEnv`, the typed context |
  | `lib/` | Config, db, errors, jobs, locks, log, metrics | No feature knowledge; knows no module |

  `modules/boundaries.test.ts` fails the build when an import breaks these.
  A module's `index.ts` exports exactly what other modules use — a name
  nobody outside uses does not belong there, and what is not there is the
  module's own to change. Shared vocabulary (`Actor`) lives in `lib/`, not
  in whichever module had it first. A module that outgrows one service file
  splits into parts in its folder — `jenkins` (shared, now, stats, search,
  actions, sync, access, retention, explainer) and `requests` (model, check,
  lifecycle, deciding, rows, and one executor per kind: `execute.ts` runs the
  Azure DevOps creations and dispatches `grant.ts` and `jira-project.ts`;
  their shared steps are `steps.ts`), with `service.ts` re-exporting the
  names its routes use.

  `app.ts` builds the app without listening so tests drive it via
  `app.request()`; `server.ts` serves it, and `index.ts` loads secrets
  (Vault, then `.env`) before importing it. Adding an area means a new
  folder under `modules/` with its `index.ts`, mounted in `app.ts`; adding
  an outside system, a folder under `integrations/`.
- `packages/contracts` — `@eidp/contracts`, the JSON the API sends and the web
  reads, as types and nothing else. See *Talking to the API*.
- `deploy/helm/eidp` — the Helm chart; each app's production image is its
  `Containerfile` (`docs/deploy.md`).

- `apps/web` — Vite + React UI (`@eidp/web`), organized by feature. Dev server
  proxies `/api` to the API on :3000.

  | Folder | Holds | Rule |
  |---|---|---|
  | `app/` | Providers, route table, shell, nav config | The only place routes are declared |
  | `features/<name>/` | One feature's pages, data access and state | Never imports another feature's internals |
  | `components/sidebar/` | `app-sidebar` plus one file per nav group | A new group is a new file mounted in `app-sidebar`, not a branch |
  | `components/` | Shared app chrome (`empty-state`) | Used by two or more features |
  | `components/ui/` | shadcn primitives | Generated — regenerate, don't hand-edit |
  | `lib/` | `api-client`, `token-store`, the query cache | No React components, no feature knowledge |

  `SidebarSeparator` between groups needs `w-auto!` — `separator.tsx` sets
  `data-[orientation=horizontal]:w-full`, which out-specifies the sidebar's own
  `w-auto`, so it renders full width plus `mx-2` and spills out of the rail.

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

## Where things are explained

Each area's detail — what it does, why, and the traps it has hit — lives in
`docs/`. Read the one you are about to change; it is written to be read whole.

| Doc | Read it before changing |
|---|---|
| [`docs/web.md`](docs/web.md) | routes, lazy pages, the Overview, motion, the map, the sidebar, the query cache, the API client |
| [`docs/ui.md`](docs/ui.md) | page titles and layout, skeletons, dialogs, tables, wrapping, DataView, the palette |
| [`docs/design.md`](docs/design.md) | colours, light/dark, brand marks, fonts, the logo |
| [`docs/integrations.md`](docs/integrations.md) | ADO, Jira, Jenkins, Ollama, Vault, the inventories parser |
| [`docs/platform.md`](docs/platform.md) | the catalog, background jobs, migrations, where health went |
| [`docs/requests.md`](docs/requests.md) | request types, lifecycle, creation, access requests, risk, forms |
| [`docs/access.md`](docs/access.md) | permissions, roles, bindings, view-as, the Access page |
| [`docs/jenkins.md`](docs/jenkins.md) | Jenkins page, My pipelines, ignoring, history and retention, build page, log viewer, explanations |
| [`docs/digest-and-activity.md`](docs/digest-and-activity.md) | the weekly digest, Platform activity |
| [`docs/chatbot.md`](docs/chatbot.md) | the chatbot, its tools and rules, streaming, markdown |
| [`docs/auth.md`](docs/auth.md) | LDAP sign-in, AD errors, the test users |
| [`docs/running.md`](docs/running.md) | `scripts/dev.sh`, the dev image |
| [`docs/deploy.md`](docs/deploy.md) | the production images, the Helm chart (`deploy/helm/eidp`), the HTTPRoute |
| [`docs/operations.md`](docs/operations.md) | logs, metrics, readiness, shutdown, scaling out, what is and isn't highly available |

## Rules that break things

The ones that have broken something before, or would quietly. Each doc says why.

- **Config** comes from `lib/config.ts`, never `process.env`. Blank `.env` values are unset.
- **A schema change is a new migration** in `lib/migrations/`; an applied file is frozen and editing it stops the boot. (`docs/platform.md`)
- **Background work is `schedule()`** in `server.ts` (`lib/jobs.ts`), never a bare `setInterval`: the API may run as several processes. (`docs/platform.md`)
- **Work a person can start that must happen once goes through `lib/locks.ts`** (`exclusive`, `tryWithLock`), not a module-level promise or `Set` alone — those hold in one replica only. (`docs/platform.md`)
- **Log with `lib/log.ts`**, never `console` (the CLI scripts aside): one line per event, fields not prose, and the request id rides along. (`docs/operations.md`)
- **The API's JSON shapes live in `packages/contracts`**, imported with `import type` only; a contract file holds no values and imports nothing outside the package. Routes that add a field say what they send with `satisfies`. (`docs/web.md`)
- **Reads go through `useResource(key, …)`**; the same key is the same request, so name keys for what they fetch. (`docs/web.md`)
- **Pages are `lazyPage`s, charts and the stage graph are lazy too** — a static import puts them back in everyone's bundle. (`docs/web.md`)
- **A guarded page is four edits**: `manageItems`, `<RequirePermission>`, `requirePermission`, and `DEVOPS_ONLY` in `modules/access/routes.test.ts`. A new permission is the contract's `Permission` plus its `PERMISSIONS` entry. (`docs/access.md`)
- **Secrets never leave the parser or the integration** (`[hidden]`), and values are never logged — names only. (`docs/integrations.md`, `docs/jenkins.md`)
- **Every colour is a token with a value in `:root` and `.dark`**; red only ever means "act on this"; meaning colours always come with an icon and a word. (`docs/design.md`)
- **All motion sits inside `prefers-reduced-motion: no-preference`.** (`docs/web.md`)
- **One `h1` per page, and `usePageTitle`.** Identifiers wrap at `/`, never `break-all`. (`docs/ui.md`)
- **Don't "fix"** the Ansible code-point sort, the doubly encoded multibranch names, or the error regex being the same on both sides of the log viewer. (`docs/integrations.md`, `docs/jenkins.md`)
- **Tests share the dev database**: delete only your own rows (ids past a floor, names made for the run), and take advisory lock 4202 around the catalog. (`docs/requests.md`, `docs/jenkins.md`)

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
