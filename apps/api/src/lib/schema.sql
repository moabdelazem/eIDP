-- Re-runnable. The catalog is derived data: it is rebuilt from the
-- inventories repo on every sync, so nothing here is authored by hand.

create table if not exists catalog_systems (
  dir           text primary key,
  project_name  text not null,
  company       text,
  teams         jsonb not null default '{}'::jsonb,
  approvers     text[] not null default '{}',
  managers      text[] not null default '{}',
  ops_teams     text[] not null default '{}',
  policy        jsonb not null default '{}'::jsonb
);

create table if not exists catalog_applications (
  id                text primary key,
  system_dir        text not null references catalog_systems(dir) on delete cascade,
  group_name        text not null,
  name              text not null,
  environment       text,
  repository        text,
  build_technology  text,
  deploy_technology text,
  deploy_platform   text,
  app_type          text,
  microservice      boolean,
  technologies      text[] not null default '{}',
  descriptor        jsonb not null default '{}'::jsonb
);

create index if not exists catalog_applications_system_idx on catalog_applications (system_dir);
create index if not exists catalog_applications_name_idx on catalog_applications (name);

-- One row, holding the outcome of the last sync so the UI can say whether what
-- it is showing is current, stale, or missing entirely.
create table if not exists catalog_sync (
  id          integer primary key default 1,
  started_at  timestamptz,
  finished_at timestamptz,
  commit_sha  text,
  ok          boolean not null default false,
  error       text,
  constraint catalog_sync_is_singleton check (id = 1)
);

insert into catalog_sync (id) values (1) on conflict (id) do nothing;

-- Self-service requests. Each row is one thing someone asked for, and the
-- whole history of what happened to it: nothing is deleted, only moved on.
create table if not exists requests (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null,
  status             text not null default 'pending',
  collection         text not null,
  -- For create_project this is the project being created.
  project            text not null,
  repository         text,
  description        text,
  justification      text not null,
  requested_by       text not null,
  requested_by_name  text not null,
  requested_at       timestamptz not null default now(),
  decided_by         text,
  decided_by_name    text,
  decided_at         timestamptz,
  decision_note      text,
  completed_at       timestamptz,
  result_url         text,
  error              text,
  constraint requests_kind_check check (kind in ('create_repository', 'create_project')),
  constraint requests_status_check check (
    status in ('pending', 'approved', 'rejected', 'completed', 'failed', 'cancelled')
  ),
  constraint requests_repository_check check (
    (kind = 'create_repository') = (repository is not null)
  )
);

create index if not exists requests_requested_by_idx on requests (requested_by, requested_at desc);
create index if not exists requests_status_idx on requests (status, requested_at);

-- Two open requests for the same thing would race each other into Azure
-- DevOps. The database refuses the second, whoever gets there first.
create unique index if not exists requests_one_open_per_target_idx on requests (
  kind, lower(collection), lower(project), lower(coalesce(repository, ''))
) where status in ('pending', 'approved');
