# e-IDP — the DevOps Portal

An internal developer portal for the organization. People sign in with their
Active Directory account and find, in one place:

- **what exists** — every system and application, read from the `inventories` repo;
- **what they can ask for** — repositories, projects and access, decided by DevOps;
- **how their builds are doing** — their Jenkins runs, why they failed, and what to try.

The portal reads the organization's systems; it does not replace them. Azure
DevOps, Jira and Jenkins stay the source of truth, and `inventories` is
read-only input.

## What's in it

### For everyone

| Page | What it does |
|---|---|
| **Overview** (`/`) | Headline counts, applications by technology, the largest systems, your recent requests, and what waits on you if you decide anything. |
| **Projects map** (`/map`) | Every system and application from `inventories`, as a zoomable map or a plain list, searchable. Each application has a page with its owners per environment, runtime settings, what each environment overrides, and every setting (secrets shown as `[hidden]`). |
| **My pipelines** (`/pipelines`) | Your Jenkins runs and your teams' — runs you started, runs of commits you wrote, runs for projects your teams own — with *Failing now* on top: each broken pipeline, how many times in a row, and the AI's reading of why. |
| **Weekly digest** (`/digest`) | Your team's week: builds, requests for its projects, and a short summary. |
| **Chatbot** (`/chatbot`, or Ctrl/⌘ J anywhere) | Ask about the platform. It answers from the portal's own data through read-only tools — applications, owners, your requests, builds — and can fill in a request form for you to check and send. It never acts. |
| **New request** (sidebar) | Ask for something; see below. |
| **My requests** (`/requests`) | Everything you asked for, as cards or a table, with counts by status and a preview of each. |
| **Your profile** (`/me`) | What the directory says about you, your groups, every role you hold and where it comes from. |

Ctrl/⌘ K jumps to any application, system or page. Light and dark themes,
or the system's, from the menu under your name.

### Self-service requests

| Request | Provider | What approval does |
|---|---|---|
| **Repository** | Azure DevOps | Creates it in an existing project, then gives you and the team you chose Contributor on it. |
| **Project** | Azure DevOps | Creates it with Git in any collection, then adds you and your team to its Contributors group. |
| **Access** | Azure DevOps | Adds up to 20 people to an existing project's Contributors group. |
| **Project** | Jira | Creates a software project you lead, and puts you and your team in its Developers role. |
| **Pipeline** | Jenkins | *Coming soon.* |

Every form checks as you type — the naming rules, whether it already exists,
whether someone already asked — with the same check the API runs on submit.
Each request is assessed for its approver (who gets access, whether they are in
the owning team, whether the project deploys to production, near-duplicate
names) with an AI summary on top of facts checked in code. Approving asks
first and says exactly what will be created and who gets access; the
requester follows it to a link and a clone command.

### For DevOps and team leads (the *Manage* section)

| Page | Who | What it does |
|---|---|---|
| **Approvals** | DevOps; team leads for their teams' access requests | The queue, with each request's risk notes, and the full history as a table. |
| **Jenkins** | `jenkins.view` | Dashboard over 24h/7d/30d, failing jobs (ignorable with a reason), searchable builds, queue and agents; run again, stop, cancel. Each build has its stage graph, parameters, commits and a log viewer that follows a running build live, and failures are explained by the AI automatically. |
| **Access** | `rbac.manage` | Who holds which role, granting and removing with reasons and expiries, "why can bob approve?", the audit log, and viewing the portal as someone else (read-only). |
| **Platform activity** | `activity.view` | Who uses the portal and what they do — sign-ins, requests, access changes, Jenkins actions — as charts, a feed and per person. |

## Who can do what

Access is role-based and managed in the portal, on the Access page:

- **Permissions** (one thing the portal can do) and **roles** (bundles of
  them: Member, Team lead, Approver, Pipeline operator, Build operator, DevOps
  admin) are defined in code.
- **Bindings** give a role to a directory group or one person — everywhere,
  or limited to one team or one project. A grant to one person needs a reason
  and can expire. Every change is audited.
- Everyone who can sign in is a **Member**, and the `APPROVER_GROUP`
  (`DEVOPS`) is **DevOps admin**. Both are built in, so the portal can never
  lock itself out.
- Group membership is read live from the directory (cached a minute) and
  bindings on every request, so a change applies at once. A role in a session
  token is never trusted on its own.

The previous portal's access map imports with a dry run first:

```sh
pnpm --filter @eidp/api rbac:import path/to/rbac.py           # what it would add, and what it leaves out and why
pnpm --filter @eidp/api rbac:import path/to/rbac.py --apply   # then write it
```

## How it's built

A pnpm workspace with three apps, all TypeScript on **Node 24** (run directly,
no build step for the services):

| App | What | Port |
|---|---|---|
| `apps/api` (`@eidp/api`) | Hono API, a modular monolith — one module per area (auth, catalog, requests, access, Jenkins, pipelines, chatbot, digest, activity) behind its own `index.ts`. Postgres for state. | 3000 |
| `apps/web` (`@eidp/web`) | React 19 + Vite + Tailwind v4 + shadcn/ui. Proxies `/api` to the API. | 5173 |
| `packages/contracts` (`@eidp/contracts`) | The JSON the API sends and the web reads, as types only — one definition for both. | — |

It talks to:

| System | For | Required |
|---|---|---|
| Active Directory (LDAP) | Sign-in, groups, profiles | Yes |
| PostgreSQL 17 | Everything the portal keeps | Yes |
| Azure DevOps Server (on-prem) | The `inventories` repo, repositories, projects, access | For the map and ADO requests |
| Jira Data Center | Jira project requests | Optional |
| Jenkins | My pipelines, the Jenkins page | Optional |
| Ollama (Qwen 2.5 on our machines) | Failure explanations, request summaries, digests, the chatbot | Optional — AI features hide without it |
| HashiCorp Vault | The API's secrets, with `.env` behind it | Optional |

Every optional integration is off until configured, and the portal says which
setting is missing rather than failing. `docs/` holds each area's design
decisions and the traps behind them, and `CLAUDE.md` the rules that break
things with an index into `docs/`; read the area's doc before changing it.

## Running it

```sh
pnpm install
pnpm dev
```

`pnpm dev` writes `.env` from `.env.example` if it is missing, starts Postgres
and OpenLDAP, and runs the apps: the UI on http://localhost:5173.

Test accounts, in `ldap/seed.ldif`:

| User | Password | Groups |
|---|---|---|
| `alice` | `alicepw` | DEVOPS, Payments |
| `carol` | `carolpw` | DEVOPS, Payments |
| `bob` | `bobpw` | Payments |
| `dave` | `davepw` | none — the RBAC tests bind roles to him |

| Command | |
|---|---|
| `pnpm dev` | everything up |
| `pnpm stop` | containers down, data kept |
| `pnpm reset` | containers down, **data wiped**, back up |
| `pnpm test` | all tests; the API's need the containers running |
| `pnpm build` | production build |

### With podman, nothing else installed

`scripts/dev.sh up` runs everything in one pod — Postgres, OpenLDAP, the API
and the UI — reading the same `.env`.

```sh
./scripts/dev.sh up        # build and start everything
./scripts/dev.sh restart   # restart the apps, e.g. after editing .env
./scripts/dev.sh build     # rebuild the image (also automatic when the lockfile changes)
./scripts/dev.sh logs      # follow the api; pass a name for another
./scripts/dev.sh status
./scripts/dev.sh down      # stop, keep the data
./scripts/dev.sh reset     # stop, wipe volumes, start again
./scripts/dev.sh services  # only Postgres and OpenLDAP, run the apps with pnpm
```

`apps/*/src` is mounted, so edits reload in place, and a `git pull` restarts
the services by itself. Worth knowing:

- Rootless podman cannot bind ports below 1024, so LDAP is published on
  **1389**; the script prints the `LDAP_URL` to use.
- Published ports are fixed when the pod is created: changing them needs a
  `down` first.
- If the browser stops reloading, file events are not crossing the bind
  mount: `VITE_POLLING=1 ./scripts/dev.sh restart`.
- `.env` never goes into an image layer.

### Without the real systems

Every integration has a stand-in, so the whole portal works on a laptop:

```sh
pnpm --filter @eidp/api ado:fake       # Azure DevOps Server on :4010
pnpm --filter @eidp/api jira:fake      # Jira Data Center
pnpm --filter @eidp/api jenkins:fake   # Jenkins, with folders, pipelines and a live build
pnpm --filter @eidp/api ollama:fake    # a model that answers like Qwen would
pnpm --filter @eidp/api vault:fake     # Vault
```

Each prints the settings to point `.env` at it.

### On Kubernetes

Each app has a production image (`apps/api/Containerfile`,
`apps/web/Containerfile`, built from the repository root), and
`deploy/helm/eidp` installs both behind an Envoy Gateway `HTTPRoute`, with
secrets from Vault or a Secret and an optional Postgres for dev clusters. See
the chart's README and `docs/deploy.md`.

## Configuration

Everything is in `.env.example`, grouped and commented: database, directory,
Azure DevOps and `inventories`, Jira, Jenkins, Ollama, Vault and the
weekly digests. The essentials:

```sh
DATABASE_URL=postgresql://eidp:eidp@localhost:5432/eidp
JWT_SECRET=<at least 16 characters>
LDAP_URL=ldap://dc01.example.com:389
LDAP_BASE_DN=dc=example,dc=com
LDAP_BIND_DN=svc-eidp@example.com
LDAP_BIND_PASSWORD=
APPROVER_GROUP=DEVOPS

# The project map, and Azure DevOps requests
ADO_BASE_URL=https://<host>/<collection>
ADO_PAT=<Code read & write; Project and Team read, write & manage>
INVENTORIES_PROJECT=<ADO project holding the inventories repo>
```

The map rebuilds from `inventories` every `SYNC_INTERVAL_MINUTES`, or at once
from **Refresh from inventories** on the map. With Vault configured, a key
there wins over `.env`; if Vault cannot be read the API boots on `.env` and
`/health` says so (`VAULT_REQUIRED=true` refuses instead).

## When something doesn't work

**A login fails.** The API tells a caller only that the credentials did not
work. To see which stage failed:

```sh
pnpm --filter @eidp/api ldap:doctor <username> [password]
```

It names the directory you are talking to and the suffixes it serves (the
valid `LDAP_BASE_DN` values), then reports the service bind, the account
lookup, the password, and the account's groups. Someone who should approve and
cannot can open **Your profile**: it lists the groups the directory returned
and every role they hold, with where it comes from.

**A page looks stale after a pull.** `./scripts/dev.sh restart`.
