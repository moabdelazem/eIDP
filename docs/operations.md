# Running it: logs, metrics, readiness, shutdown, scale

What the API does so it can run as several replicas behind a load balancer
and be operated there — and what it leans on that is not its own to make
highly available. The chart that sets it up is `docs/deploy.md`; how work is
shared between replicas is `docs/platform.md`.

**Logs are one line per event** (`lib/log.ts`): JSON when `NODE_ENV` is
production (the image sets it) or `LOG_FORMAT=json`, `key=value` text
otherwise. Fields, not sentences — `{"msg":"job failed","job":"jenkins-sync",
"error":"…"}` — so a collector can count and filter. Every line written while
handling a request carries its `requestId`, and `uid` once auth has run (and
`actor` when an admin is viewing as someone): `AsyncLocalStorage`, so nothing
has to pass them along. The id is the Gateway's `x-request-id` when it sent
one — Envoy makes one per request — and goes back on the response, so Envoy's
access log, ours, and what a user reports are one request. A job run's lines
carry `job`. One `request` line per request (method, route pattern, status,
ms); probes are not logged — the kubelet asks every few seconds, and a
draining pod answers not-ready on purpose. Values are never logged, names
only (CLAUDE.md). `LOG_FORMAT` and `LOG_LEVEL` are read straight from the
environment, like Vault's settings: the log must work before config is
parsed. The CLI scripts (`ldap:doctor`, `rbac:import`) still print with
`console` — their output is for a person at a terminal.

**Metrics** (`lib/metrics.ts`) are Prometheus' text format on `METRICS_PORT`
(9464), a port of their own the HTTPRoute never exposes. Requests by route
pattern and status, and their latency; requests in flight (streams
included); job runs by outcome and duration; the Postgres pool (total, idle,
waiting); event-loop delay, memory, CPU. No client library: a counter and a
histogram are a page of code. Labels are bounded — a route's pattern, never
its path, or every build number would be a series. Waiting connections
above zero and event-loop delay are what say a replica is short of
something; CPU is what the HPA scales on.

**Readiness is not liveness.** `/health` is liveness: the process is up. It
never touches Postgres — restarting a pod does not bring a database back,
and every pod would restart at once. `/health/ready` is readiness: Postgres
answers within two seconds and the process is not shutting down. A replica
that loses the database leaves the Gateway's rotation and comes back by
itself. The startup probe asks `/health`, which answers only after
migrations: the server listens after they run.

**Shutdown drops nobody.** On SIGTERM (`server.ts`): readiness says no at
once, but the server keeps serving for `SHUTDOWN_DELAY_SECONDS` (5) —
endpoints reach the Gateway a moment after the pod is marked terminating,
and requests sent in that moment must not find the door shut. Then no new
connections, no new job runs, and the job leases and locks it holds are let
go, so another replica takes the work at once instead of waiting out a
lease. Requests in flight get `SHUTDOWN_GRACE_SECONDS` (20) to finish — a
chatbot answer streaming, a sync — and are then cut. The pod's
`terminationGracePeriodSeconds` (40 in the chart) must cover both. A request
being created that is cut stops heartbeating and is failed for retry by
recovery, exactly as after a crash. The web pods sleep 5 s in `preStop` for
the same reason, and nginx's SIGQUIT finishes what it is serving.

**Bounded waits everywhere.** A Postgres connection is waited for 5 s; a
statement runs at most `DB_STATEMENT_TIMEOUT_SECONDS` (60, migrations exempt);
a call to Jenkins, Jira or Azure DevOps `HTTP_TIMEOUT_SECONDS` (30; a whole
build log four times that); a git fetch five minutes; Ollama
`OLLAMA_TIMEOUT_SECONDS`. Without them one hung server ties up requests —
and, worse, holds a lock others are waiting on.

**Scaling out.** Any number of API replicas: migrations take an advisory
lock, jobs claim leases, and work people start is held once across replicas
(`docs/platform.md`). Sessions are JWTs signed with one shared `JWT_SECRET`,
so any replica answers anyone. Each replica opens up to `DB_POOL_MAX` (10)
connections to Postgres: `maxReplicas × DB_POOL_MAX` plus whatever else uses
it must fit `max_connections` (100 by default) — past that, raise it or put
a pooler in front. A pooler in transaction mode needs care: migrations hold
a session advisory lock (4201) on one connection for their whole run, so
they need a session-mode address. Everything else holds nothing on a
connection between statements — its locks are rows. The web app is
static files and scales freely. What stays per replica, deliberately: the
directory-group cache (a minute), Jenkins' queue (seconds), kept log tails,
the catalog's owner index — each a cache whose miss is only a read.

**What is and isn't highly available.** The portal's own processes are: two
or more of each, spread across nodes and zones, a PodDisruptionBudget, no
state of their own. What they lean on is not theirs to make so:

- **Postgres** holds everything. Production needs it highly available
  itself — a managed service, CloudNativePG, Patroni — reached by one
  address that follows the primary. The chart's own Postgres is one pod, for
  dev and test only.
- **The directory** is one `LDAP_URL`. Point it at a name that resolves to
  several domain controllers (the domain's own DNS name usually does), or a
  load balancer in front of them; sign-in is down while it is.
- **Jenkins, Azure DevOps, Jira and Ollama** are single services the portal
  reads. When one is down its pages say so and everything else works; syncs
  and jobs record the failure and try again on the next run.
- **Vault** is read once at boot. A replica that cannot read it falls back
  to its Secret, or refuses to start with `VAULT_REQUIRED`; running replicas
  are not affected by Vault going away.
