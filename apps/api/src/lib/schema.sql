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

-- The directory group the requester chose as their team. It gets Contributor
-- access alongside them once the thing exists. Null on rows filed before
-- teams were asked for; those grant the requester alone.
alter table requests add column if not exists team_group text;

create index if not exists requests_requested_by_idx on requests (requested_by, requested_at desc);
create index if not exists requests_status_idx on requests (status, requested_at);

-- Two open requests to *create* the same thing would race each other into
-- Azure DevOps. The database refuses the second, whoever gets there first.
-- Access requests are left out: several people asking for access to one
-- repository at once is normal, and granting twice is harmless.
drop index if exists requests_one_open_per_target_idx;
create unique index if not exists requests_one_open_create_idx on requests (
  kind, lower(collection), lower(project), lower(coalesce(repository, ''))
) where status in ('pending', 'approved') and kind <> 'grant_access';

-- Access requests: who is to be granted (directory account names) and at what
-- level. The repository is optional there — without one, the whole project.
alter table requests add column if not exists grantees text[];
alter table requests add column if not exists access_level text;
alter table requests drop constraint if exists requests_kind_check;
alter table requests add constraint requests_kind_check
  check (kind in ('create_repository', 'create_project', 'grant_access'));
alter table requests drop constraint if exists requests_repository_check;
alter table requests add constraint requests_repository_check check (
  (kind <> 'create_repository' or repository is not null)
  and (kind <> 'create_project' or repository is null)
);
alter table requests drop constraint if exists requests_grant_check;
alter table requests add constraint requests_grant_check check (
  kind <> 'grant_access'
  or (cardinality(grantees) > 0 and access_level in ('read', 'contribute'))
);

-- Files the last sync could not read, relative to the repo root. Added after
-- the table existed, so it is an add-if-missing rather than part of the create.
alter table catalog_sync add column if not exists warnings jsonb not null default '[]'::jsonb;

-- Who may do what beyond the built-in grants (see services/rbac.ts). A binding
-- gives a directory group, or one user, a role — everywhere, or limited to a
-- team or an ADO project. Roles and permissions live in code; only who holds
-- them lives here, so the admin page can change it without a deploy.
create table if not exists rbac_bindings (
  id            uuid primary key default gen_random_uuid(),
  subject_type  text not null check (subject_type in ('group', 'user')),
  subject       text not null,
  role          text not null,
  scope_type    text not null default 'global' check (scope_type in ('global', 'team', 'project')),
  scope         text,
  -- Required for a user binding (checked in the service): an exception for
  -- one person is exactly what someone asks about a year later.
  reason        text,
  expires_at    timestamptz,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  check ((scope_type = 'global') = (scope is null))
);

create unique index if not exists rbac_bindings_unique_idx on rbac_bindings (
  subject_type, lower(subject), role, scope_type, lower(coalesce(scope, ''))
);

-- Every grant and revoke, with the binding as it was. Append-only.
create table if not exists rbac_audit (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  actor    text not null,
  action   text not null check (action in ('grant', 'revoke')),
  binding  jsonb not null
);

-- Viewing the portal as someone else (read-only) is audited beside grants.
-- Such a row names a target instead of a binding.
alter table rbac_audit add column if not exists target text;
alter table rbac_audit alter column binding drop not null;
alter table rbac_audit drop constraint if exists rbac_audit_action_check;
alter table rbac_audit add constraint rbac_audit_action_check check (action in ('grant', 'revoke', 'assume'));
