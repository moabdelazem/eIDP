-- 0001 — the schema as it stood when migrations began.
--
-- It was the old re-runnable schema.sql, so it is written to apply over a
-- database that already has some or all of it: that is how a database made
-- before migrations takes this as its first one without losing a row. Like
-- every migration once applied, it is frozen — a change to the schema is a
-- new numbered file, never an edit here (the runner refuses to boot when an
-- applied file's checksum changes).

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
-- requests_kind_check gains grant_access below, with the Jira kind: this file
-- runs top to bottom on every start, so a constraint is set once, in its
-- final form. An earlier, narrower copy here once refused to boot as soon as
-- a row of a later kind existed.
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

-- A binding's reason or expiry changed after it was granted: the row holds it
-- as it became, and `previous` as it was. The action check, set once for
-- 'assume' and 'update' together (see requests_kind_check above for why).
alter table rbac_audit add column if not exists previous jsonb;
alter table rbac_audit drop constraint if exists rbac_audit_action_check;
alter table rbac_audit add constraint rbac_audit_action_check check (action in ('grant', 'revoke', 'assume', 'update'));

-- Jira projects. Jira has no collections, so those rows carry none, and the
-- project key — what every issue is numbered with, PAY-123 — beside the name.
alter table requests add column if not exists project_key text;
alter table requests alter column collection drop not null;
alter table requests drop constraint if exists requests_kind_check;
alter table requests add constraint requests_kind_check
  check (kind in ('create_repository', 'create_project', 'grant_access', 'create_jira_project'));
alter table requests drop constraint if exists requests_jira_check;
alter table requests add constraint requests_jira_check check (
  (kind = 'create_jira_project') = (collection is null)
  and (kind = 'create_jira_project') = (project_key is not null)
);

-- One open request per Jira name and per key: both are unique in Jira. The
-- ADO index above cannot see these rows, since their collection is null.
create unique index if not exists requests_one_open_jira_name_idx on requests (lower(project))
  where status in ('pending', 'approved') and kind = 'create_jira_project';
create unique index if not exists requests_one_open_jira_key_idx on requests (lower(project_key))
  where status in ('pending', 'approved') and kind = 'create_jira_project';

-- Who asked the portal to act in Jenkins. Jenkins itself only sees the
-- service account, so without this "who re-ran the prod deploy" has no answer.
-- Refused attempts are kept too. Append-only.
create table if not exists jenkins_audit (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor       text not null,
  actor_name  text not null,
  action      text not null check (action in ('rebuild', 'stop', 'cancel')),
  job         text not null,
  build       integer,
  queue_id    bigint,
  ok          boolean not null,
  error       text
);

-- Ignoring a failure is recorded beside the actions: it changes what DevOps
-- see as broken. `note` carries the reason given.
alter table jenkins_audit add column if not exists note text;
alter table jenkins_audit drop constraint if exists jenkins_audit_action_check;
alter table jenkins_audit add constraint jenkins_audit_action_check
  check (action in ('rebuild', 'stop', 'cancel', 'ignore', 'unignore'));

-- Failing jobs set aside on purpose — a job known to be broken and being dealt
-- with, or abandoned — so "failing now" is what still needs someone. One row
-- per job; it holds until the job passes after `from_number`, or until
-- `expires_at` (null: until someone stops ignoring it).
create table if not exists jenkins_ignored (
  server          text not null,
  job             text not null,
  from_number     integer not null,
  until_pass      boolean not null,
  expires_at      timestamptz,
  reason          text not null,
  ignored_by      text not null,
  ignored_by_name text not null,
  created_at      timestamptz not null default now(),
  primary key (server, job)
);

-- Jenkins build history, so the Jenkins page can say what happened over a day
-- or a week and search builds by their parameters without sweeping Jenkins
-- for thousands of builds on every look. Derived data: rebuilt by the sync
-- (services/jenkins-sync.ts) from Jenkins, never edited by hand. Keyed by the
-- server, so a test's fake Jenkins never touches a real server's rows.
create table if not exists jenkins_jobs (
  server      text not null,
  full_name   text not null,
  url         text not null,
  buildable   boolean not null default true,
  in_queue    boolean not null default false,
  last_number integer,
  primary key (server, full_name)
);

create table if not exists jenkins_builds (
  server      text not null,
  job         text not null,
  number      integer not null,
  -- success | failure | unstable | aborted | not_built | running
  result      text not null,
  started_at  timestamptz not null,
  duration_ms bigint not null default 0,
  url         text not null,
  built_on    text,
  -- [{name, value, hidden}], secrets already '[hidden]' — they never reach this table.
  parameters  jsonb not null default '[]'::jsonb,
  causes      text[] not null default '{}',
  primary key (server, job, number)
);

-- Who wrote the commits each build built: a push builds as the service account
-- that triggered it, so the author is who the run is for (My pipelines).
alter table jenkins_builds add column if not exists authors text[] not null default '{}';

-- A Pipeline run does not say which agent it ran on (only freestyle builds
-- report builtOn), so the sync asks its stages or its log afterwards, a batch
-- at a time; this marks a finished build already asked, found or not.
alter table jenkins_builds add column if not exists agent_checked boolean not null default false;

create index if not exists jenkins_builds_started_idx on jenkins_builds (server, started_at desc);
-- For the hourly retention (services/jenkins-retention.ts).
create index if not exists build_explanations_created_idx on build_explanations (created_at);
create index if not exists jenkins_audit_at_idx on jenkins_audit (at);
create index if not exists jenkins_builds_running_idx on jenkins_builds (server, job) where result = 'running';

-- One row per server: the outcome of the last sync, so the page can tell
-- current from stale from never-synced.
create table if not exists jenkins_sync (
  server      text primary key,
  started_at  timestamptz,
  finished_at timestamptz,
  ok          boolean not null default false,
  error       text,
  -- Builds written by the last sync, and jobs it had to read in detail.
  builds      integer not null default 0,
  jobs_read   integer not null default 0
);

-- Who Jenkins itself lets read each job, from its role-based strategy or its
-- matrix grants (integrations/jenkins/access.ts). Derived data, replaced
-- whole by each read (services/jenkins-access.ts); grants to everyone
-- (authenticated, anonymous) are never stored — they name no team.
create table if not exists jenkins_job_access (
  server   text not null,
  job      text not null,
  sid      text not null,
  -- user | group | either (an old matrix grant does not say which)
  sid_type text not null,
  -- what grants it: "role payments-devs", "folder payments", "the job"
  via      text not null,
  primary key (server, job, sid, sid_type, via)
);

create index if not exists jenkins_job_access_sid_idx on jenkins_job_access (server, lower(sid));

create table if not exists jenkins_access_sync (
  server      text primary key,
  read_at     timestamptz,
  -- role-strategy | matrix | none, from the last read that worked
  source      text,
  grants      integer not null default 0,
  ok          boolean not null default false,
  error       text,
  warnings    text[] not null default '{}'
);

-- A model's explanation of a failed Jenkins build, kept so each failure is
-- explained once however many people open it. Keyed by prompt version and
-- model too: a new prompt or a bigger model is a new answer, not the old one
-- served as current. Keyed by server like the rest of the Jenkins history.
create table if not exists build_explanations (
  server           text not null,
  job              text not null,
  number           integer not null,
  prompt_version   integer not null,
  model            text not null,
  -- {summary, cause, category, confidence, evidence: [{line, text}], nextSteps}
  explanation      jsonb not null,
  -- Only part of the log fitted the context window.
  trimmed          boolean not null default false,
  prompt_tokens    integer not null default 0,
  duration_ms      integer not null default 0,
  created_by       text not null,
  created_by_name  text not null,
  created_at       timestamptz not null default now(),
  primary key (server, job, number, prompt_version, model)
);

-- The assistant's conversations. Each belongs to one person, who alone can
-- read it; deleting it deletes its messages. Tool results are not kept —
-- only what was asked, what was answered, and what was looked up to answer.
create table if not exists assistant_conversations (
  id          uuid primary key default gen_random_uuid(),
  uid         text not null,
  title       text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists assistant_conversations_uid_idx on assistant_conversations (uid, updated_at desc);

create table if not exists assistant_messages (
  id               bigserial primary key,
  conversation_id  uuid not null references assistant_conversations(id) on delete cascade,
  role             text not null check (role in ('user', 'assistant')),
  content          text not null,
  -- What the assistant looked up to answer, as shown to the person.
  steps            jsonb not null default '[]'::jsonb,
  model            text,
  created_at       timestamptz not null default now()
);

create index if not exists assistant_messages_conversation_idx on assistant_messages (conversation_id, id);

-- The chatbot (the tables keep the assistant's name): a name the person gave
-- a conversation is never overwritten by the model's, and each answer can be
-- marked useful or not.
alter table assistant_conversations add column if not exists titled boolean not null default false;
alter table assistant_messages add column if not exists feedback text check (feedback in ('up', 'down'));

-- Automatic explanations that did not work: how often, and why. A build the
-- model cannot explain is tried twice, fifteen minutes apart, then left for
-- someone to ask by hand — never retried on every sync.
create table if not exists build_explain_attempts (
  server           text not null,
  job              text not null,
  number           integer not null,
  prompt_version   integer not null,
  model            text not null,
  attempts         integer not null default 0,
  last_error       text,
  last_attempt_at  timestamptz not null default now(),
  primary key (server, job, number, prompt_version, model)
);

-- What an approver should know before approving a request (services/
-- request-risk.ts): facts the portal checked, the level they add up to, and
-- the model's one line on them. One per request, remade on "Assess again".
create table if not exists request_assessments (
  request_id       uuid primary key references requests(id) on delete cascade,
  level            text not null check (level in ('low', 'medium', 'high')),
  facts            jsonb not null default '[]'::jsonb,
  summary          text,
  reason_concerns  jsonb not null default '[]'::jsonb,
  model            text,
  prompt_version   integer not null,
  -- Why there is no summary, when the model was asked and failed.
  error            text,
  created_at       timestamptz not null default now()
);

-- A team's finished week (services/digest.ts): the facts counted in code, and
-- the model's words on top, kept so it reads the same after its builds age out.
create table if not exists weekly_digests (
  team           text not null,
  week_start     date not null,
  facts          jsonb not null,
  summary        text,
  highlights     jsonb not null default '[]'::jsonb,
  model          text,
  prompt_version integer not null,
  error          text,
  created_at     timestamptz not null default now(),
  primary key (team, week_start)
);

-- What people do on the portal that no other table records (services/activity.ts):
-- signing in, a sign-in refused (with the name typed and why — never the
-- password), a page opened (the path only, never its query, which can carry
-- searches), and a question asked of the chatbot (that one was asked, never
-- its words; conversations can be deleted, this count is not). Everything
-- else on Platform activity is read from the tables that already record it.
-- Kept ACTIVITY_RETENTION_DAYS.
create table if not exists activity_events (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  uid     text not null,
  name    text not null,
  kind    text not null check (kind in ('sign_in', 'sign_in_failed', 'visit', 'chat')),
  path    text,
  section text,
  reason  text
);

create index if not exists activity_events_at_idx on activity_events (at);
create index if not exists activity_events_uid_at_idx on activity_events (lower(uid), at);
