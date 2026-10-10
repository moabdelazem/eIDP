# Integrations

Azure DevOps Server, Jira, Jenkins, Ollama, Vault and the inventories parser — each one's quirks and the traps it has. Moved out of CLAUDE.md, which keeps the rules that break things and points here.

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
shipped. Build logs are read through `logText/progressiveText?start=`,
streamed and kept to their tail (the build page's 256 KB), where a failure
explains itself. Jenkins spools that answer before writing it, so its
`X-Text-Size` and `X-More-Data` headers arrive however long the log; a
build's first read is the whole log (Jenkins gives no size up front), and
after that a running build's three-second polls fetch only the bytes added
and a finished one is served from memory (`logTail`, 32 tails, ~8 MB) to
everyone who opens it or asks why it failed. A Jenkins that sends no size is
read whole every time, as before. The fake serves `progressiveText` as
LargeText does, a start past the end meaning the log rolled over.
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
