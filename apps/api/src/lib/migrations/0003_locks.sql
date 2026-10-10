-- 0003 — work done once across every API process (lib/locks.ts).
--
-- A row is a held lock: a sync, a model call for one build, one person's
-- chatbot answer. The holder renews `expires_at` while it works, so a process
-- that dies lets go within the lease, and anyone may take an expired row.
create table locks (
  name        text primary key,
  owner       text not null,
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null
);
