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
  `app.request()`; `server.ts` serves it, and `index.ts` loads secrets
  (Vault, then `.env`) before importing it. Adding an integration means a new
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
so `JenkinsIcon` defaults to the text colour. `PostgresIcon` draws in its blue; `VaultIcon` defaults
to the text colour too (its yellow vanishes on paper), and `OllamaIcon` is
black anyway. System health shows every component by its mark
(`features/system/icons.tsx`, Lucide where there is none — the directory,
the portal's own jobs); the sidebar's health alert shows the down tools'
marks in the rail's ink (`tone="current"`), never their colours.

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

`integrations/jenkins/` — Jenkins' remote access API, `<JENKINS_URL>/.../api/json`
with `tree` so it sends only what is asked. `JENKINS_USER` + `JENKINS_TOKEN` (an
API token, Basic auth); API-token calls are exempt from CSRF crumbs, so none are
fetched, and a password in `JENKINS_TOKEN` would fail every POST. A job's full
name carries its folders (`payments/loan-api`), so `jobPath` turns it into
repeated `job/` segments and the routes take it as a value, not a path.
Multibranch branches are named with an encoded slash (`feature%2Fx`), encoded
once more in the URL — don't "fix" the double encoding. **Only freestyle builds
report `builtOn`**; a Pipeline run never does, so the agent comes from its
stages' `execNode` (Stage View), else the "Running on X in …" lines at the
start of its log (`pipelineAgents`, reading only the first 64 KB). The sync
fills `built_on` for builds without one, newest first, `AGENTS_PER_SYNC` at a
time (`agent_checked` marks a finished build already asked); a run that moved
lists them `a, b`. The fake reports `builtOn` only for freestyle jobs, as
Jenkins does — it once reported it for all, which is how an empty Agent column
shipped. Build logs are read as a
stream keeping only the last 64 KB, where a failure explains itself.
`fake-server.ts` stands in for it (`pnpm --filter @eidp/api jenkins:fake`).

`integrations/ollama/` — Ollama on our own machines (Qwen 2.5 by default,
`OLLAMA_MODEL`), for the portal's AI features. Optional: without `OLLAMA_URL`
every AI feature hides itself. Answers are asked for as JSON against a schema
(`format`), not parsed from prose. `num_ctx` is sent on every call and input is
trimmed to fit it: Ollama's default window is small, and past it the prompt is
cut silently *from the front* — the instructions go, and the answer is about
what is left. A model nobody pulled is a 404, reported as "ollama pull <model>".
`fake-server.ts` answers like a model would (`pnpm --filter @eidp/api
ollama:fake`), and can invent a line number or break its JSON on request. For
the chatbot it streams, and calls the tool a question's words point to —
only among those offered — or a rogue one when asked to.

`integrations/vault/` — HashiCorp Vault as the source of the API's secrets,
with `.env` behind it. `src/index.ts`, the entry point, awaits `loadSecrets()` and
only then *dynamically* imports `server.ts`: a static import would be
evaluated before the `await` — top-level await does not hold back sibling
imports — and `lib/config.ts` would parse `.env` alone. Scripts that read
config run through `with-secrets.ts` for the same reason (`ldap:doctor`,
`rbac:import`). It writes what it read into `process.env`, so config parses as
it always has; a key in Vault wins over `.env`. Only names in `CONFIG_KEYS`
(`lib/config-schema.ts`) are taken — a secret store must not set
`NODE_OPTIONS` or `PATH` for the API and every git it starts. KV v2 by default
(`<mount>/data/<path>`), v1 by setting; several paths, the later winning; a
token, or AppRole whose token is revoked after the read; a namespace header
when set. **If Vault cannot be read** — unreachable, sealed, a refused login
or policy, a path that is not there — nothing from it is applied (never half
the paths) and the API boots on `.env`, the reason in the log;
`VAULT_REQUIRED=true` refuses to boot instead. `/health` says `secrets: vault |
env | env-fallback` (`lib/secrets-state.ts`), and a config error after a
fallback says Vault was not read, or people fix the wrong file. Its own
`VAULT_*` settings are read from `process.env` directly — they are what config
waits for. Values are never logged, names only. `fake-server.ts` stands in
(`pnpm --filter @eidp/api vault:fake`).

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
DevOps is unreachable: `server.ts` kicks the sync off in the background and the
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

**Every request is assessed for its approver** (`services/request-risk.ts`),
in the background the moment it is filed, and shown only to people who may
decide it — on the approval card, in the approve dialog when it is not low,
and in full on the request page ("Before you approve", with Assess again).
The **facts** are the portal's, checked in code: who gets access and whether
they are in the teams that own the project (`teamsOwning`, from the catalog);
whether that project deploys to `prd`/`prd_dr`; whether the requester is in
an owning team; near-duplicate names in ADO or Jira (`similar`: case,
punctuation, a suffix, a typo or two); and a reason under six words. The
**level** is the count of cautions — none, one, several: low, medium, high —
so it is testable and no model can talk it up or down. The **model** adds only
words: a one-line summary of those facts, and at most two notes on whether the
reason explains the request, labelled as its reading. Without Ollama, or when
it fails, the facts and the level still stand and the page says why there is
no summary. One row per request (`request_assessments`), replaced on Assess
again; the risk tests live in `requests.test.ts`, because that file deletes
every request, and take the catalog lock (4202) around their own system.

**Every request form has one shape** (`features/requests/form-layout.tsx`):
a header naming the kind and provider, the form as a card of numbered
sections (where, what, who, why), labels above and persistent help below,
`(optional)` on the optional fields rather than marks on required ones, each
live check answered under its own field (`CheckMessage`), a reason that warns
before it reads as thin (`ReasonField`, the same six words `request-risk.ts`
flags), and an action bar — Cancel then the primary, last — that names the
first thing still missing instead of a silently disabled button. Beside it a
sticky `ReviewPanel`: what is asked for, a readiness checklist with progress,
what happens next. A new form composes these; it does not lay itself out. The
request page leads with the kind and provider, the name large, and a
four-stage tracker (`stagesOf`); deciders get a decision card at the top, and
Withdraw sits in the header.

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
| **Role** | a named bundle of permissions (`member`, `team-lead`, `approver`, `pipeline-operator`, `build-operator`, `devops-admin`) | `ROLES`, in code |
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

**The Access page** (`features/admin/`) is a working tool, its tab and
filters in the URL (`?tab=check&uid=bob`, `?status=expiring`). Across the
top: bindings to groups and to people, what expires within `EXPIRING_DAYS`
(14), and what needs cleaning up — an expired binding grants nothing but stays
listed, and one whose role left the code is "Role gone" — with a callout that
filters to them. **Bindings** is a table to work in: search, group/person,
role and status filters, sortable columns, select several to remove at once,
and a row menu — check the person, edit the reason and expiry (`PATCH
/rbac/bindings/:id`, audited as `update` with the binding as it was in
`previous`; who, role and scope never change, that is a new binding), grant
the same to someone else, remove. A role's name opens a hover card of what it
allows. **Granting** is a side sheet: group or person (a person checked
against the directory as typed), the role as cards with their permissions,
where (typeahead from `GET /rbac/suggestions`: the catalog's teams and
projects, and groups already bound), why, and an expiry from presets or a
day; a sentence at the foot says what will be granted. **Check someone**,
**Roles** (one grid, roles against permissions, each column opening its
bindings) and the **Audit log** (by day, filtered by action and searched)
are tabs. shadcn's registry is blocked by the environment's network policy,
so `checkbox.tsx` and `hover-card.tsx` were written from shadcn's source, as
`collapsible.tsx` was. Inside a dialog, anything that opens on focus (a hover
card) must not be the first focusable thing, or it opens over the dialog. The
tab contents are a `minmax(0,1fr)` grid, so a wide table scrolls in its box
instead of widening the page.

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

**Jenkins** (`/jenkins`, `features/jenkins/`) is a Manage page behind
`jenkins.view`. Its tabs — Dashboard, Failing, Builds, Queue, Agents,
Activity — and the 24h/7d window and search all live in the URL, so a link
lands on exactly one view. `jenkins.operate` adds three actions — run a build
again, stop a running one, take one out of the queue — each behind a
confirmation. Both are `devops-admin`'s, and `build-operator` bundles them to
bind to anyone else. Every action goes to Jenkins as the service account, so
`jenkins_audit` records who asked, refused attempts included; the Activity tab
reads it, and the tests delete only rows they made (`id > ` the max before).

**My pipelines** (`/pipelines`, `features/pipelines/`, `services/pipelines.ts`)
is the same Jenkins for everyone else, a browse item behind `pipelines.view`
(a `member` permission) — and it lists **runs**, not jobs, because a job is
often shared: one build job and one deploy job for every project. A run is:

- **yours** when you started it (`Started by user <uid or display name>`), or
  when it built a commit you wrote — whoever started it. Pushes are built by
  the service account maika, so the commit author is the person a push run is
  for. The sync keeps each build's commit authors (`jenkins_builds.authors`:
  name, Jenkins user id and email), matched to your login, name and `mail`.
- **your team's** when it is for a project a team of yours owns. Its project
  is what its **parameters** name (`APP_NAME=loan-scoring-api`,
  `REPOSITORY=…/loan-scoring-api.git` — values matched whole, or by their last
  path segment without `.git`, against the catalog's applications and
  repositories), and only when they name none, what the job's own name does
  (`payments/loan-scoring-api`, multibranch `agriland-api/main`). So a shared
  deploy job shows each team only its own projects' runs, never every run of
  the job. Don't key it on the job alone again.

Each run says why (*You started it*, *Your commit · run by maika*,
*Payments' project*). **Failing now** (`failing-now.tsx`) leads the page:
each pipeline whose latest finished run broke, how many in a row, and the AI's
reading of it — summary, category, what to try — with *See why* (the build
page, where the cited lines are), *Ask the chatbot*, or *Explain this failure*
when the automatic run has not reached it. `mine()` carries each failed run's
kept answer (`explanation`, a `Brief`: no evidence, that is the build page's),
read for the whole list in one query (`keptFor`), and `ai` says whether the
caller may ask and whether Ollama is there; the section hides without it. The
page narrows by group (`?group=Payments`, `me`
for just yours), window (`24h`/`7d`/`30d`, newest 500) and view: Runs, or
Pipelines — a row per job, and per project on a shared job, summed over the
runs you may see. Queue items are judged the same way, from the parameters
and causes Jenkins' queue carries.

**Jenkins has the last word on a team's runs** when its rules can be read.
`integrations/jenkins/access.ts` reads either the role-strategy plugin (project
roles: a regex over full names, matched whole and case-sensitively, and their
users and groups) or matrix grants in each folder's and job's `config.xml`
(all three spellings matrix-auth has written; grants flow down folders unless
an item stops inheriting). Only Job/Read counts; global roles are left out.
Grants to `authenticated`/`anonymous` are kept as `authenticated`: they name
no team, but they are how a shared job is readable by everyone.
`services/jenkins-access.ts` keeps them in `jenkins_job_access` every
`JENKINS_ACCESS_SYNC_MINUTES` (15); a failed read keeps the last rules. Once
rules exist, a team's run shows only if Jenkins lets the person read its job —
the portal reads with a service account that sees everything, and must not
show a team what Jenkins hides from it. A grant on a job also makes its runs
someone's, but only runs that name no project: a grant on a shared job says
nothing about whose each run is. Without rules (`source: none`, or the service
account may not read roles — it needs to administer them, or Job/ExtendedRead
for matrix), the catalog decides, and the page says which. The fake has both
(`FAKE_JENKINS_ACCESS=role-strategy|matrix`), stating one rule set two ways,
and the shared `platform/build` (maika, on push, with commit authors) and
`platform/deploy` (`APP_NAME`) jobs.

Acting is `jenkins.operate`, **scoped**, and judged per run: bound globally it
reaches every run (`build-operator`), bound to a team or project only runs for
the projects that team or project owns (`pipeline-operator`, which also
carries `pipelines.view`) — on a shared deploy job, the runs for its apps and
no others. Writing the commit or being in the team never lets you act; a rerun
can deploy to production, so that is a binding someone made on purpose. The
`/jenkins` action routes take anyone holding `jenkins.operate` anywhere and the
service judges the stored run (`demandOperate`); `cancel` judges the queued
item by what it will run with. A run opens at `/pipelines/build` on the Jenkins
build page (`BuildPage`, one of `features/jenkins`' public pieces with
`ActionDialog`, `result.tsx` and the types): `GET /jenkins/run` answers a run
that is not yours with 404, and returns `canOperate` so the page never guesses.
Links into the Jenkins page's search show only to `jenkins.view`. The tests are
`routes/pipelines.test.ts`; they put their own systems in the catalog under
lock 4202.

**Ignoring a failure** (`jenkins_ignored`, `POST /jenkins/ignore` and
`/unignore`, global `jenkins.operate`) sets a failing job aside — known broken,
being dealt with, or abandoned — so "failing now" is what still needs someone.
A reason is required; it holds until the job passes again after the build it
was ignored at, or for 1/7/30 days, or until someone stops it
(`IGNORE_HOLDS`, the one SQL every reader uses). Ignored jobs leave the
Failing tab, its count and the automatic explanations, are listed under
Ignored with who, why and until when, and are marked in "Failed most". Both
are written to `jenkins_audit` (`note` holds the reason), so the Activity tab
shows them.

The **Dashboard** also answers, each in its own chart: build time (typical and
slowest 5%, one hue, dashed for the tail — never a second axis), what starts
builds (by person or service account, SCM, timer, upstream), builds per agent
(with failure rate and busy time in the tooltip), why builds failed (the
model's categories, labelled as its reading), and time to fix — the median from
a job's first failure to its next pass, against the window before. Ranked
charts are top eight plus "Other", from the API. `RankedBars` and
`DurationChart` live in the lazy `charts.tsx` with the rest.

**System health** (`/system`, `features/system/`, `services/health.ts`) is a
Manage page behind `system.health` (`devops-admin`): every dependency asked
now — Postgres, the directory (service bind, and whether it serves
`LDAP_BASE_DN`), Vault (`sys/health`, and whether the secret paths still read,
values dropped), Azure DevOps, Jira, Jenkins (version header), Ollama (model
pulled?), and the background jobs judged against their interval (late after
three missed runs). Each is ok, degraded, down or off (not configured is off,
never down), says what to do, and what in the portal depends on it. Only
Postgres or the directory down makes the portal *down*; Vault going away
after boot is a warning — the running API keeps its settings, the next
restart would fall back to `.env`, and a boot that already fell back says to
restart. Checks run in parallel, each within 8 s, and one answer is shared for
15 s (`?fresh=1`, Check again, skips it). Names, versions, counts and ages
only — never a secret. `/health` stays the public liveness probe.

It is laid out as public availability pages are: one verdict across the top
("All systems operational", "Partial outage", "Major outage" — red only when
something is down), then each component with its state now and a **bar per
day** of the last 90, the worst it was that day, with its uptime — samples not
down, out of samples where it was configured; degraded counts as up, as
status pages count it. A row opens (shadcn `Collapsible`) to its facts and a
24-hour response-time sparkline; a component that is down opens by itself.
**Past incidents** follow, a day at a time for a week, "No incidents
reported" said outright. The history is `health_samples`: `recordSample()`
asks everything every `HEALTH_SAMPLE_MINUTES` (5) from `server.ts`, so it is
sampled evenly whether or not anyone looks, kept `HEALTH_RETENTION_DAYS` (90);
`GET /system/history` turns it into days, uptime, latency and incidents — a
run of samples not ok, closed by the next ok one, open while it lasts. Days
before sampling began are grey "No data", never an outage. A phone shows the
last 30 days.

The **sidebar carries it** for whoever may see the page:
`SystemHealthProvider` (`features/system/health-context.tsx`, mounted in
`app-sidebar`) asks once a minute — nobody else's browser asks at all — and
shares the answer. While anything is **down**, `nav-health.tsx` puts a red
alert at the foot of the rail on every page (one red icon with a tooltip when
collapsed), linking to the page; System health carries a red count of what is
down, or an amber dot (`--sidebar-warning`, the amber lifted for the dark
rail) when something only needs attention — a warning is not an alarm on
every page. The health page publishes its own answers, Check again included,
so the sidebar never lags what the page shows. The alert link stays a link;
a separate `sr-only` `role="alert"` announces it once.

**Weekly digest** (`/digest`, `features/digest/`, `services/digest.ts`) is a
team's week — its builds, the requests for its projects, the portal's
incidents — for the people in it, a browse item for everyone. Built as the
risk summary is: the **facts** are counted in code, the **model** adds only a
two-or-three-sentence summary and at most three highlights, labelled as its
reading; without Ollama the facts stand and the page says why. A team is a
`team.yml` value in the catalog; you read the digests of the teams your
directory groups are, and `digests.all` (`devops-admin`) reads every team's
and may *Write again* a finished week. A team's runs are `teamRuns` in
`services/pipelines.ts` — judged as My pipelines judges a team's run
(parameters, else the job's name; Jenkins' rules when read), so the two pages
never disagree. Its requests are those whose `team_group` is the team or whose
project the team owns. Weeks are ISO weeks in UTC. A finished week is written
once and kept (`weekly_digests`) by a timer every `DIGEST_CHECK_MINUTES` (60)
after Monday — one team at a time, shared GPU — or on the first look; it reads
the same after its builds age out. Only the last `WEEKS_BACK` (4) weeks can be
counted, because builds are kept 30 days. The week in progress is counted
live and never summarised, and its count deltas are hidden: half a week
against a whole one is not a change. Tests: `routes/digests.test.ts`, under
lock 4202, writing their own builds, requests and samples. `Kpi`
(`components/kpi.tsx`) is shared with the Jenkins dashboard.

**Platform activity** (`/activity`, `features/activity/`, `services/activity.ts`)
is a Manage page behind `activity.view` (`devops-admin`): who uses the portal
and what they do in it. Most of it is read from where it is already recorded —
requests filed and decided (`requests`), access granted, changed, removed and
viewed-as (`rbac_audit`), Jenkins actions including refused ones
(`jenkins_audit`), failures someone asked the AI about (`build_explanations`,
not `e-idp`'s) — as one `union all` (`EVERYTHING`). What nothing recorded
lives in `activity_events`: sign-ins and refused sign-ins (the name typed and
the error code, never the password — `routes/auth.ts`), pages opened, and
chatbot questions (that one was asked and from which page, never its words;
a deleted conversation does not uncount it). Pages are reported by the shell
(`app/page-visits.tsx`, on each pathname change) as the **path only** — the
query can carry searches — once per person and path per 30 s, and grouped
into the sidebar's sections in the API (`sectionOf`). Never while viewing as
someone: the shell skips it and the API refuses the POST anyway, so an
admin's look around is never put down to the person they viewed as. Kept
`ACTIVITY_RETENTION_DAYS` (90), pruned hourly from `server.ts`.

The page: six headline counts against the window before (24h/7d/30d), and an
amber callout when one name is refused five or more times — a lockout in the
making, or someone guessing. Tabs, all in the URL with their filters
(`?tab=feed&who=bob&group=jenkins&q=…`): **Overview** (people active per hour
or UTC day, pages by section top eight plus "Other", most active — visits not
counted), **Feed** (sentences a day at a time, narrowed by person, kind and
words, `Show older` paging on the `next` cursor; the same thing repeated in a
row is one line with ×N) and **People** (each person's window). Visits count
but are never feed lines — one per click would bury everything. Tests:
`routes/activity.test.ts`, deleting only rows past the ids it started at.

**History is the portal's own copy.** A day or a week of builds, searchable by
parameter, cannot be swept from Jenkins on every look, so
`services/jenkins-sync.ts` keeps `jenkins_builds` (with parameters, causes and
agent) and `jenkins_jobs` in step, every `JENKINS_SYNC_SECONDS` (60) and on
Refresh, single-flight. A sync is one light call for the job list (each job's
last build number) plus one call per job that built since, or had a build
still running — a handful a minute; only the first reads every job, up to
`BACKFILL` builds each. "Since" is the newest build stored *or* the last number
the previous sync saw, whichever is higher: without the second, a job whose
builds are all older than `JENKINS_RETENTION_DAYS` (30) would be backfilled on
every sync. A job that cannot be read keeps its old mark, so its builds are
read next time rather than skipped. Every table is keyed by `server`, so the
tests' fake Jenkins never touches a real server's rows. Queue and agents are
still asked live (15-second cache): only "now" matters for them.

Secrets never reach the table: parameter values under secret-like names, and
password parameters (Jenkins never returns their value), are `[hidden]` in
the integration, before storing — so search cannot find them either. Search
(`GET /jenkins/runs`) is words that must all match: `NAME=value` narrows to a
parameter (either side partial), anything else matches job, parameter value,
cause, agent or `#number`; `%` and `_` are characters, not wildcards.

The Dashboard compares the window with the one before it (deltas on each KPI;
colour says better or worse, the arrow says direction, builds count stays
neutral). Builds by result stack failure → unstable → success → aborted from
the baseline, in `--chart-failure/-unstable/-success/-aborted` (`index.css`,
validated; the meaning colours' text tones failed CVD against the red).
Success rate is its own chart — never a second axis on the first — with a
marker on every point, or a lone hour between two empty ones draws nothing.
The charts are `features/jenkins/charts.tsx`, lazy like the Overview's.

"Run again" is a rebuild, not "Build now": the same parameters the build had,
because a failed deploy re-run with defaults deploys something else. A build
with a password parameter or a file one is refused rather than re-run blank.

A build has its own page (`/jenkins/build?job=a/b&number=12` — the job carries
folders, so it rides in the query): its stages — from the **Pipeline Graph
View** plugin's `pipeline-graph/tree` when the server has it, the only source
that says what ran in parallel (`Stage.branches`), else Stage View's flat
`wfapi` (`stagesFrom` says which; none on a freestyle job) — drawn as a graph
(`stage-graph.tsx`: stages left to right, a parallel stage's branches stacked
in its column, SVG lines under HTML nodes so each node is a real button) or
as a list, the plain path to the same stages; phones open on the list, and the
choice is kept per browser. **Expand** opens the graph in a dialog nearly the
screen's width — larger nodes with each stage's agent and start, and a line
saying how the run went — and where the stages will not sit side by side (a
phone) it runs top to bottom, parallel branches side by side, rather than
scrolling sideways. Picking a stage there closes the dialog without focus
returning to the button, which would scroll the page away from the log. Its
motion (`graph-*` in `index.css`, all under `no-preference`) follows the run:
stages arrive column by column, `--i` times `--step`, the lines draw in
behind them (`pathLength=1`, so every curve draws over the same dash), a line
into a running stage marches and the running stage pulses; a stage that never
ran is reached by a dashed line. A stage opens the log at its
`[Pipeline] { (name)` heading (a branch's `Branch: name`, else its stage's).
The sync's agent lookup still reads `wfapi` only — the tree is one more call
per build it does not need. The fake serves the tree for the `payments`
folder only, so both paths stay tested. Then parameters (each a
link to every build that had it), commits, agent, and the last 256 KB of the
log in `log-viewer.tsx` — opened at the first error, with find, error-to-error
jumps, errors-with-context, hiding `[Pipeline]` steps, and wrap. Find wins over
those filters, or "3 of 40" steps through lines nobody can see. Stage headings
stay pinned at the top of the box while their lines scroll under them (lines
are siblings of the box's content, never wrapped one by one — sticky sticks
only within its parent — and headings skip `content-visibility`, which would
stop drawing them), shell commands (`+ …`) read as `$ …`, and `timestamps {}`
prefixes become a column of their own. **A running build is a tail**: the page
asks every 3 s, the log opens at the end and keeps to it — a `ResizeObserver`
re-pins it, because lines below the fold only take their wrapped height once
drawn — new lines fade in, and a Live bar says which stage it is in. Scrolling
up pauses following; *Jump to latest* (with how many lines came since) or
scrolling back down resumes it. The fake's running build grows its log two
lines a second from when the fake started. It scrolls the
log box itself, never `scrollIntoView`, which also scrolled the page and
shifted the sidebar rail.

**"What went wrong"** on a failed or unstable build (`explain-panel.tsx`,
`services/build-explainer.ts`) is made **automatically** for each job's latest
failure (`services/auto-explain.ts`), after the Jenkins sync that finds it, so
the answer is usually waiting when someone opens the build; anything else
(an older failure, one the run could not do) is a click. The automatic run is
kept small because every answer is shared GPU time: only each job's *latest*
build and only when it failed or was unstable — a job failing twenty times in
a row is explained once per new failure, not twenty times; only within
`OLLAMA_AUTO_EXPLAIN_HOURS` (24), so turning it on does not work through a
month of history; at most five per run, one at a time, newest first. A build
the model fails on is tried once more fifteen minutes later
(`build_explain_attempts`), then left for a click, and its error shown. When
Ollama itself is down (unreachable, model missing) the run stops without
counting it against the build, and the next sync tries again. Automatic
answers are by `e-idp` ("e-IDP, automatically"); the explainer's single
flight means a click during an automatic run shares its call. The Failing tab
and the chatbot's `jenkins_failing` carry each failure's one-line summary.
`OLLAMA_AUTO_EXPLAIN=false` turns it off. Asking about one build
(`GET`/`POST /jenkins/explain`) needs only `ai.chat` — everyone's — and the run
itself, through `demandView`: anyone who may see a run may ask why it failed,
and a run that is not theirs is a 404 before the model is asked. `ai.use`
(`devops-admin`, `build-operator`) still decides whether Jenkins-wide lists —
the Failing tab, the chatbot's `jenkins_failing` — carry every job's summary. The model
gets the facts (failed stage, parameters, commits, agent) and an *excerpt* of
the log, numbered as the build page numbers it: each error line with six
before and three after, every stage heading, and the last 30 lines — or the
last 120 when nothing reads as an error. "Error line" is the same regex on both
sides (`ERROR` in `build-explainer.ts` and `log-viewer.tsx`); change them
together. Over budget, the first error and the end are kept, then errors from
the last backwards: the first is usually the cause, the last what stopped it.

Three rules keep the answer honest, each tested in
`routes/jenkins-explain.test.ts`: `redact` removes URL credentials,
authorization headers, secret-named `key=value` and `--flag value`, private
keys and token shapes before the model sees anything; a cited line must be one
the model was shown, or it is dropped; and the cited text is the log's own, not
the model's. Broken JSON is asked for once more, then reported. Answers are kept
in `build_explanations` per build, prompt version (`PROMPT_VERSION`) and model —
change the prompt, bump it — so each failure is explained once for everyone,
and two people asking at once share one call. The panel says the answer is
generated, by which model, for whom and when, and that it can be wrong; each
cited line jumps the log viewer to it.

**The chatbot** (`/chatbot/:conversationId?`, `features/chatbot/`,
`services/chatbot.ts`; it was "the assistant", and `/assistant` links redirect)
is an agent inside the portal with the same model, for everyone: `ai.chat` is a
`member` permission. General engineering it answers from what the model knows;
questions about *us* it answers through read-only tools in
`services/chatbot-tools.ts` — applications, configuration, owners, your
requests and one request, what waits for your approval, Jenkins failures,
builds and numbers, your pipelines, one build in detail (stages, the branch
that broke, the stored explanation, the redacted end of its log), a team's
week (`peek` — never a second model call mid-answer), the portal's health, and
`whoami` (your groups, teams and every permission with the group or binding
behind it). Five rules hold it, each tested in `routes/chatbot.test.ts`:

- **It looks, never acts.** No tool creates, approves, runs or changes
  anything. For a request it **drafts**: `draft_request` returns the form's
  URL filled in (`?project=…&repository=…&from=chatbot`), the forms read
  their fields from the query, and `DraftedNote` says the chatbot filled it
  in — the person checks it and submits it. A prefilled project takes the
  spelling ADO uses.
- **Tools are offered per person.** Each tool has an `allowed(access)`; without
  `jenkins.view`, Jenkins does not exist for the model, and a build is read
  through `demandView`, as the build page reads it. A call to a tool not
  offered — invented, or not this person's — is refused, not run.
- **Tool results are data, not instructions** (the prompt says so), capped in
  size, and already redacted where they are stored (`[hidden]`).
- **Conversations are the owner's alone** — anyone else's id is a 404, to
  read, continue, rename, delete or give feedback on.
- **It knows the page it is asked from**: `context` (path and tab title, a
  portal path only) goes into the system prompt, so "why did this build
  fail?" on a build page is about that build.

It streams: Ollama's NDJSON (`chatStream`, tool calls arrive whole) becomes
server-sent events (`conversation`, `step`, `delta`, `reset`, `done`, `title`,
`error`) through `hono/streaming`, read by `apiStream` in `lib/api-client.ts` —
not `EventSource`, which can neither POST nor send the token. Refusals (busy,
not yours, not configured) are checked *before* the stream opens, so they are
ordinary JSON errors. A turn that calls tools may have streamed a preamble;
`reset` drops it. Up to five tool rounds, then the model answers with what it
has. One answer at a time per person; closing the page aborts the model call.
The question is stored at once, the answer only when complete, and tool
results never — the next turn asks again, which keeps history small and data
current. History is trimmed from the oldest to fit `num_ctx`. A new
conversation is **named by the model** after its first answer (`title`), never
over a name the person gave it (`titled`); **regenerate** drops the last answer
and answers its question again; each answer takes a thumbs up or down
(`feedback`), kept beside it. The tables keep the assistant's name
(`assistant_*`): renaming them is a migration for a word.

The UI is one `ChatThread` and one `useChat` hook in two places: the full page
(conversations grouped by when they were used, searchable, renamable) and the
**dock** (`chatbot-dock.tsx`, mounted in `AppShell`): a launcher in the corner
of every page but the chatbot's own, or Ctrl/⌘ J, opens the chat in a sheet
over the page, with questions to start from that fit the page and the
person's permissions; other pages hand it a question with `askChatbot`
(`lib/ask-chatbot.ts`, a window event, so no feature imports the chatbot's
internals) and it opens and sends it; its conversation carries on from page to page for the
session (`sessionStorage`), opens in the full page with one click, and a link
in an answer closes it onto that page. Steps fold into "Looked up N things"
once the answer is written; the thinking dots move only under `no-preference`.

Answers are markdown, rendered by **react-markdown** with `remark-gfm` into
React elements — never HTML, since a model that read our data wrote it:
`skipHtml`, and links only to portal paths (in-app) or http(s) (new tab).
CommonMark reads `_x_` inside a word as text, so `NBFS_LoanManagementSystem`
stays a name. Code blocks are highlighted by Shiki in their fence's language,
each grammar its own chunk loaded the first time it appears
(`highlightCode` in `lib/highlight.ts`), with copy. `markdown.tsx` is
lazy-loaded, so the parser is not in the bundle the dock rides on. The catalog
tests and the chatbot tests share `pg_advisory_lock(4202)`: `catalog.test.ts`
replaces the catalog wholesale, and they run in parallel processes.

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
