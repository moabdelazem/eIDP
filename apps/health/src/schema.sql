-- The health service's tables (apps/health). It shares the portal's Postgres
-- and owns these; the portal reads health_samples for the weekly digest and
-- nothing else. Re-runnable, top to bottom, every start: each constraint is
-- set once, in its final form.

-- Every component's state, every HEALTH_SAMPLE_MINUTES: the portal's own
-- dependencies (read from its /internal/health) and every machine
-- (`machine:<id>`). The portal's schema creates the same table so the digest
-- can read it before this service has ever run; this adds what only the
-- health service writes.
create table if not exists health_samples (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  component  text not null,
  status     text not null check (status in ('ok', 'degraded', 'down', 'off')),
  latency_ms integer,
  summary    text not null
);
create index if not exists health_samples_component_at_idx on health_samples (component, at);
-- The component's name as it was, so history needs no list of what exists now.
alter table health_samples add column if not exists name text;
-- A machine's readings: cpu, memory, disk, load, uptime, each port and URL.
alter table health_samples add column if not exists metrics jsonb;

-- Our machines, managed on the portal's System health page. A machine is
-- checked by what it lists: TCP ports, an HTTP URL, a node_exporter URL.
create table if not exists health_machines (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  host          text not null,
  ports         integer[] not null default '{}',
  http_url      text,
  exporter_url  text,
  grp           text not null default 'Servers',
  environment   text,
  -- Who hears about this machine, on top of HEALTH_ALERT_TO.
  notify        text[] not null default '{}',
  notes         text,
  enabled       boolean not null default true,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  updated_by    text,
  updated_at    timestamptz
);
create unique index if not exists health_machines_name_idx on health_machines (lower(name));

-- Every add, change and removal of a machine, as it was and as it became.
create table if not exists health_machine_audit (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  actor     text not null,
  action    text not null check (action in ('add', 'update', 'remove')),
  machine   jsonb not null,
  previous  jsonb
);

-- The alert outbox. The health service writes a row when something goes down
-- or degraded (HEALTH_ALERT_AFTER samples in a row) and when it recovers; it
-- never sends anything itself. The mail service, when it exists, claims
-- pending rows (`for update skip locked`), sends them, and marks them sent or
-- failed — nothing here changes for it. Empty `recipients` means the mail
-- service's default list.
create table if not exists health_alerts (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  component   text not null,
  name        text not null,
  kind        text not null check (kind in ('down', 'degraded', 'recovered')),
  summary     text not null,
  recipients  text[] not null default '{}',
  state       text not null default 'pending' check (state in ('pending', 'sending', 'sent', 'failed')),
  attempts    integer not null default 0,
  last_error  text,
  sent_at     timestamptz
);
create index if not exists health_alerts_state_idx on health_alerts (state, at);
create index if not exists health_alerts_component_idx on health_alerts (component, at desc);
