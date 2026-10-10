-- 0002 — the API safe to run as more than one process.
--
-- Background jobs (lib/jobs.ts) claim a lease here before running, so each
-- runs in one process per interval however many are up; the row is also
-- what /health/jobs reports.
create table job_runs (
  name          text primary key,
  -- Held while a run is in progress; a lease older than the job's stale
  -- limit belonged to a process that died mid-run and may be taken over.
  running_since timestamptz,
  owner         text,
  last_started  timestamptz,
  last_finished timestamptz,
  ok            boolean,
  error         text,
  summary       text,
  duration_ms   integer
);

-- A request being created stamps this while it works (services/requests.ts),
-- so recovery fails only the ones whose process stopped — never another
-- process's live work, which failing every `approved` row at boot would.
alter table requests add column heartbeat_at timestamptz;
