# The catalog, jobs and the schema

How the catalog is built and refreshed, how background work runs on several processes, how the schema changes, and where health went. Moved out of CLAUDE.md, which keeps the rules that break things and points here.

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

**Background work is jobs** (`lib/jobs.ts`, registered in `server.ts`):
catalog sync, Jenkins sync (with auto-explain after it), Jenkins access,
Jenkins and activity retention, weekly digests and request recovery. The API
may run as several processes. Each keeps a timer per job, but a run first
claims its row in `job_runs` — one `update … where` nobody is running it and
its last start is an interval old — so each job runs in one process per
interval. A lease, not an advisory lock: a lock lives on a connection, and
one held per running job would starve the pool the jobs query. A lease older
than `staleMs` (three intervals, at least 30 minutes) belonged to a process
that died and may be taken over. A run that throws is logged and recorded and
never stops the timer. A restart within an interval does not re-run what ran
before it — a catalog sync is not repeated because the API came back up;
with `SYNC_INTERVAL_MINUTES=0` it is still built once at boot. `GET
/health/jobs` lists every job with when it last started and finished and
whether it worked — names and times only, the error stays in the log and the
row — for a monitor to read. Tests: `lib/jobs.test.ts` races two owners for
one lease. On shutdown a process gives back the leases it holds
(`stopJobs`), so another picks the job up at its next tick. The per-process
caches (directory groups, Jenkins' queue, kept log tails, the catalog's
owners) stay per process: each is a minute or less of staleness, and a cache
miss only costs a read.

**Work people start is held once across processes** (`lib/locks.ts`, the
`locks` table). A promise kept in a module variable joins a second call in
the same process — and only there: behind a load balancer the timer, a
click on one replica and a click on another are three syncs, two git fetches
into one checkout, the same build explained twice on the shared GPU. So:

- `exclusive(name, work, joined)` — the catalog sync, the Jenkins sync and
  its access rules, a build's explanation, a weekly digest, a request's risk
  assessment. One process does the work; a caller elsewhere waits for it to
  finish and returns `joined()`, what it kept — or does the work itself when
  nothing was kept. The in-process promise stays in front, so callers in one
  process share one wait.
- `tryWithLock(name, work)` — one person's chatbot answer: a second, from
  another tab on another replica, is refused (`chatbot_busy`) rather than
  queued.

A lock is a lease like a job's, but short: held 30 s and renewed every 10 s
while the work runs, so a process that dies lets go within half a minute;
deleted when the work ends, throws or the process shuts down. Tests:
`lib/locks.test.ts`. A module-level promise alone is for work that only a
job starts — the job's lease already makes it one per cluster.

**The schema is migrations** (`lib/migrations/NNNN_name.sql`, run by
`migrate()` in `lib/db.ts` at boot, before anything else). Each file is
applied once, in order, in its own transaction with its row in
`schema_migrations` (name and checksum), under advisory lock 4201 so two
processes — or the test files — never apply one twice. A failing migration
leaves nothing behind and is tried again next boot. **An applied file is
frozen**: change it and boot stops naming it, because the database no longer
matches what the file says — a schema change is always a new file. `0001_baseline`
is the old re-runnable `schema.sql`, which is why a database made before
migrations takes it as its first without losing a row; it is the only file
that needs to be re-runnable. The old file's trap is gone with it: replaying
a narrower `requests_kind_check` before the line that widened it once
refused to boot over a Jira request. `lib/migrate.test.ts` applies the real
migrations over rows of the newest kinds, and drives the runner's rules
(order, once, rollback, frozen) on a scratch schema with scratch files.
Databases that ran the health service still hold its `health_*` tables; a
migration that drops them is one line when nobody wants them.

`POST /catalog/sync` needs `catalog.sync`: a sync clones from Azure DevOps with
the service account's token and rewrites the catalog. The map's **Refresh from
inventories** button (`refresh-catalog-button.tsx`, also on the map's
unavailable page) calls it and shows only to holders. `syncCatalog()` is
single-flight across processes — a call while one runs anywhere joins it —
because the timer and a click can overlap, and two fetches into one checkout
fight over git's lock. A git fetch that stalls is killed after five minutes
rather than holding that lock.

**Health is not the portal's.** System health — every dependency checked
now, 90 days of uptime, our machines, alerts — was built here and taken out
again: a separate health service will own it. Nothing in the portal asks its
dependencies how they are on a timer, and there is no `/system` page,
`system.health` permission or chatbot health tool. `/health` stays: it is the
public liveness probe compose and the dev script wait on; `/health/ready` is
readiness (`docs/operations.md`). Databases that ran
the old code keep its `health_*` tables; nothing reads them, and the new
service may take them or they can be dropped.
