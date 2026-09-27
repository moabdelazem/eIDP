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
