# Requests

The request types, their lifecycle and the rules each is tested on: approval, creation, Jira, access requests, the risk assessment and the forms. Moved out of CLAUDE.md, which keeps the rules that break things and points here.

**Request types live in one registry**, `apps/web/src/features/requests/kinds.ts`,
grouped by provider (Azure DevOps, Jira, …). The sidebar's New request
dropdown, the same dropdown on My requests, the Ctrl/⌘ K palette, the routes,
the breadcrumbs and the form's title all read it. Paths are provider-scoped
(`/requests/new/azure-devops/project`) because an Azure DevOps project and a
Jira project are different things. A type with `kind: null` is listed as
"Soon" and disabled, and gets no route.

Adding a type: its registry entry, its form, and its API `kind` with an
executor file in `modules/requests/` and its branch in `execute.ts` — then
flip `kind` from null. The sidebar
uses a dropdown rather than one item per type (shadcn's sidebar-06 pattern):
types will outgrow a flat list, and a dropdown is the only thing that still
works in the collapsed icon rail.

`modules/requests/service.ts` owns the lifecycle: pending → approved → completed or
failed, or pending → rejected or cancelled. Rows are never deleted; the row is
the history.

The rules that matter, each tested in `modules/requests/routes.test.ts`:

- **Only someone who may decide it decides**: `requests.decide` for anything,
  or `requests.decide_access` within its scope for an access request — see
  *Who may do what* below. Worked out from the directory and the bindings at
  the moment of deciding; the `roles` claim in the JWT is a UI hint only.
- **DEVOPS may decide their own requests.** This was once refused (a second
  member had to approve), and was dropped on purpose for speed; `decided_by`
  still records who approved what. Don't reintroduce it without asking.
- **Approval claims the row** with `update … where status = 'pending'`. Two
  approvers clicking at once produce one update and one creation.
- **One open creation per target** is a partial unique index, not app code, so
  two people cannot race into asking for the same repository. Access requests
  are excluded: several people asking for the same access is normal.
- **Creation runs after the approve call returns.** A project can take a minute
  in ADO. While it works, the process stamps `heartbeat_at` every 30 s;
  `recoverInterrupted()` — at boot and every minute as a job — fails only
  `approved` rows whose heartbeat went quiet (90 s), so a dead process's work
  surfaces for retry and another live process's work is left alone.
- **ADO project creation is asynchronous.** The POST returns a queued
  operation; `createProject` polls it to the end rather than reporting success
  for something the server might still fail to create.

**Approval grants access, not just existence.** The requester and the team
they chose on the form — one of their own directory groups, checked live at
submit so nobody hands a repository to a group they are not in — get
Contributor: on a repository, an ACE in the Git namespace (read, contribute,
branch, tag, notes, pull requests; not force-push, policy exemption or
permission management); on a project, membership of `[Project]\Contributors`.
`integrations/ado/access.ts` finds each ADO identity by account name and
refuses to guess when a name matches nothing or two domains. Identities are
resolved *before* creating, so an unknown team fails with nothing made;
`result_url` is written the moment creation succeeds, so a retry after a
failed grant only grants. The ADO service account therefore needs Manage
permissions on repositories and the right to edit project group membership —
without them requests end `failed` with "Created X, but could not grant
access", and a retry finishes once that is fixed. Rows filed before teams
existed have `team_group` null and grant the requester alone.

**Jira projects** (`create_jira_project`) carry a name and a key and no
collection — `collection` is null on those rows and `project_key` is set, which
`requests_jira_check` enforces; two partial unique indexes keep one open
request per name and per key. `check()` asks Jira's own
`projectvalidate/key`, because the key pattern, its length and the reserved
words are server configuration, and only the server sees archived projects,
whose keys stay taken. Approval creates a `software` project from
`JIRA_PROJECT_TEMPLATE` (Scrum by default), led by the requester, then puts the
requester and their team in the `JIRA_MEMBER_ROLE` project role (Developers).
Same rules as ADO: both are found in Jira before anything is created,
`result_url` is written once the project exists, and `addToRole` adds only
actors not already in the role — Jira refuses the whole call if any one is,
which would make a retry fail forever. The service account needs Jira's
*Administer* global permission to create projects.

**Access requests** (`grant_access`) give up to 20 people, by login name,
Contribute on a whole existing project — membership of `[Project]\Contributors`.
Scope and level are fixed, not chosen: the API does not accept a repository or
a level for them and `submitGrant` stores `null` and `contribute` regardless.
Rows filed before that was fixed may carry a repository or Read, and
`executeGrant` still honours them (ACEs via `READER`/`CONTRIBUTOR` in
`access.ts`, or `[Project]\Readers`), so don't delete that branch while such
rows can be pending. `check()` confirms the project exists and that the
directory knows every name, so a typo is caught on the form rather than after
approval. Every name is resolved in ADO before anything is
granted, so one unknown name grants nobody rather than half the list, and a
retry just grants again — both operations are idempotent. The form is its own
page (`grant-access-page.tsx`); the badge says Granting/Granted, not
Creating/Created.

**Pipelines** (`create_pipeline`) write an application into the inventories
repository for a repository that already exists — the old portal's "create
new application". The request carries the repository and a `pipeline`
document (application, technology, version, deploy target, library, the
technology's own fields, and for a project new to inventories its team.yml
and namespaces); `requests_pipeline_check` keeps that column to this kind.

- **The technology registry** (`modules/requests/pipeline/technologies.ts`)
  is the old `TECH_CONFIG` and its templates in one place: each technology's
  label, versions, fields and deploy targets, and a function writing its
  files; namespaces are registered per deploy target. The form is built from
  it (`GET /requests/pipeline/technologies`), so a technology added there is
  on the form with its fields. Until one is registered the form says none is
  set up.
- **`definitions.ts` is the old `tech_config.py` as data**, key for key so the
  two can be compared: per technology, the application in inventories it is
  copied from (per deploy target — no K8s reference, no K8s), the keys patched
  from the version (`versionTagOverrides`, `versionFieldOverrides`), and its
  special cases (`appPathReferenceMap`, `dockerfileByTarget`,
  `generatedFiles`, `isDatabase`). The old generator kept no templates of its
  own: it copied a real application of the same kind and patched it. So a
  template is handed the inventories working copy, read-only (`Inventories`:
  `exists`, `read`, `list`), as well as the request. The environments a new
  project names namespaces for are the old ones, in their order — OCP `dev`,
  `qc`, `uat`, `prd`, `prd_dr`; K8s adds `preprod` — and the application name
  rule is the old `APP_NAME_REGEX`, at most 50.
- **The templates are edited in the portal**, on Manage → *Pipeline
  templates* (`/pipeline-templates`, permission `pipelines.templates`, which
  only `devops-admin` holds). They are rows in the database
  (`pipeline_templates`, `pipeline/templates.ts`), not files in the image, so
  a template changes without a release. Every save and removal is kept in
  `pipeline_template_history`, with who made it. There is one template per
  *slot*:
  - each technology's `group_vars` per deploy target (Flutter on OCP: one per
    `app_path`);
  - its manifests per target, for ocp-templates;
  - `project`, a new project's `group_vars/all`.

  *Import from the reference* reads the slot's reference application from a
  fresh copy of its repository, on the server, into the editor. It does not
  save anything. The reference's name becomes `__APPLICATION__`
  (`__PROJECT__` for the project; manifests only in their paths, as the old
  portal copied them). A literal credential becomes `changeme`. The page
  lists what to check: each credential replaced, and each file where the name
  was replaced more than once. Saving refuses:
  - a credential;
  - a path that is not plainly relative;
  - the same path twice;
  - more than 200 files or 256 KB a file;
  - for the project template, a folder or a `team.yml` (the requester fills
    that in).

  **A technology is on the request form only for the targets whose templates
  are all saved**, so nobody can file what cannot be written. Removing one
  takes it off the form at once.
- **`generate.ts` is the old `new_applications.py`**, file for file, checked
  byte for byte against the Python when ported:
  `<system>/<application>.yml` (OCP without `preprod`, K8s with it, a
  database on `localhost`); the application's `group_vars` from its template
  with `repository_name`, the library keys, Maven's artifact/group (and
  `group_path` = `group_id`), .NET's `app_path`/`nuget_name`/version fields,
  Flutter's `app_path`, the proxy's Dockerfile per target, the image tags
  from the version (`yaml-edit.ts`, line-level, so the rest of the file is
  untouched), and the generated files; for a new project, the template
  project's files, `team.yml` and one namespace per environment
  (`cluster_type` DR for `prd_dr`); for a database, `host_vars/localhost`
  when the project has none.
- **After the push, Jenkins** (`pipeline/follow-up.ts`): provisioning, then a
  first test build, as the old approval ran them right after its push. Each
  is a row in `request_steps`, moved along by the `pipeline-steps` job every
  ten seconds, one process at a time:
  - `pending` → `queued` (Jenkins' queue item) → `running` (its build) →
    `succeeded` or `failed`;
  - the test build is `waiting` until provisioning succeeds;
  - a step not configured is `skipped`, with what to run by hand (the old
    printed command, for provisioning).

  The state is in the database, never in memory, so a restart or a second
  replica carries on. Claiming a step is the lock that sends its build once.
  A queue item Jenkins has let go of is found among the job's builds by its
  `queueId`. A step with no result after `PIPELINE_STEP_TIMEOUT_MINUTES` fails.

  **The request is complete with the push, whatever Jenkins does next.** Its
  files are in inventories either way, so a failed step is the step's to
  retry, by a decider on the request page (`POST
  /requests/:id/steps/:step/retry`), never a reason to push again. Running
  provisioning again puts the test build back to waiting. The test build can
  also be started by hand while provisioning is failed or skipped (done
  outside the portal). A failed step shows under "Needs you" on deciders'
  Overview.

  The jobs are settings, templates over the request's values `{collection}`,
  `{project}`, `{system}`, `{application}`, `{repository}`, `{newProject}`,
  `{deployTarget}` and `{technology}`:
  - `PIPELINE_PROVISION_JOB` and `PIPELINE_PROVISION_PARAMETERS` (a query
    string; by default `COLLECTION`, `PROJECT`, `APP_NAME`, `NEW_PROJECT`);
  - `PIPELINE_TEST_JOB` (e.g. `{project}/{application}/develop`) and
    `PIPELINE_TEST_PARAMETERS`.

  The old `jenkins_client.py` was not available when this was written. Check
  the job names and parameter names against the real provisioning job before
  turning it on.
- **What approval leaves to a person** is listed on the completed request
  (*Still to do by hand*): each namespace's token, and its user when left
  empty, written as placeholders, never real.
- **`check()`** refuses an application name inventories would misread — one
  starting with an environment prefix (`prd_api` is read as the `prd`
  override of `api`), or `all` — an unknown technology, a missing version or
  field, a repository ADO does not have, an application the catalog already
  has, a pipeline already asked for, and a project whose new-or-existing
  answer does not match the catalog (`GET /requests/pipeline/project`). For a
  new project every team is required, and so is the auto-deploy-to-QC answer:
  it starts unset, as on the old form, rather than defaulting to no.
- **The files are worked out at approval, not at filing** (`files.ts`), from
  inventories as they are then; anything that appeared while the request
  waited is a conflict, and nothing is ever overwritten. Deciders read the
  exact files first (`GET /requests/:id/pipeline`, the request page's
  *What approving writes*); the requester never sees them.
- **Approval pushes straight to the default branch** (`write.ts`), as the old
  portal did: in a working copy of its own (`INVENTORIES_WRITE_CHECKOUT`,
  never the catalog sync's), reset to the remote before every write, one
  writer at a time across replicas (`inTurn` on lock `inventories-write`). A
  push overtaken by someone else's starts again from a fresh copy, three
  times. Every commit carries `e-IDP-Request: <id>`, and a retry looks for
  it first, so a push that landed but was never recorded is found rather
  than made twice. The commit is the request's result, and the catalog is
  synced at once. `INVENTORIES_GIT_URL` points the writer elsewhere — a
  mirror, or the local repository the tests push to. The ADO service
  account's PAT needs Code (read & write) on inventories and ocp-templates.
- **The manifests go to ocp-templates** (`OCP_TEMPLATES_REPO`, in the
  inventories' project unless `OCP_TEMPLATES_PROJECT` says otherwise), under
  `<project>/<application>/`, from the `manifests/<Technology>/<target>` template
  — the old `reference_template` copy, the name replaced in paths only, as it
  was. Not for a library, nor a technology without a reference on that
  target. Both repositories are planned before either is pushed, so a
  conflict in one writes nothing; ocp-templates is pushed first, then
  inventories, each with the marker, so a retry after only the first landed
  finishes the second. The old portal pushed them separately and could leave
  an application without its manifests. The request's result is the
  inventories commit.
- `team.yml` is written the way the repository spells it, in the old order —
  the auto-deploy flag quoted, an empty list as one empty item, and the ops,
  approver, prd-only and manager lists DEVOPS when left empty (the form says
  so).

**Deciders adjust a waiting request instead of rejecting it to be filed
again** (`adjust.ts`, `PATCH /requests/:id`, the request page's *Adjust*).
What they may change depends on the kind:
- a repository: its collection, project and name;
- a project: its collection and name;
- a Jira project: its name and key;
- a pipeline: its application name and version, and the files it writes.

Access requests change nothing: who gets access is the requester's to ask.

Each change is checked as filing it would be (`check(target, except)`, which
leaves the request itself out of the duplicate search) and recorded in
`requests.adjustments` with who made it and the value asked for. The
requester sees each change in the activity timeline as asked → as it will be
done, and the request is assessed again.

A pipeline's files are edited under *What approving writes*. The rules:
- only the content of a file approving writes, never a new path;
- only edits that differ from what the templates write are kept
  (`requests.pipeline_edits`);
- never a credential.

The preview and the push lay the edits over the templates' output
(`applyEdits`). An edit to a file approving no longer writes stops the push
instead of being dropped. Renaming the application sets the edits aside,
and says so. The requester sees which files were edited, not what they say:
reading files is the approver's job.

The old portal let approvers override names (`override_params`) and the
generated YAML (`override_file_changes`) at approval, with no trace of what
had been asked for.

**What it does differently from the old portal, on purpose.** The port keeps
the old generator's output, not its traps:

| The old portal | Here |
|---|---|
| Worked out the files when the request was filed and stored them; the approver approved a snapshot that could be stale | Worked out at approval against inventories as they are then; what changed meanwhile is a conflict |
| Pulled a shared checkout from the page; two people at once raced | One working copy, reset before every write, one writer at a time across replicas |
| "Treat as new project" override, so a project's `team.yml` could be written over | New or existing comes from the catalog and is checked again at approval; `group_vars/all` is never written over |
| No duplicate check: two people could ask for the same app | An open request for the same application or repository blocks a second |
| Any typed version, even one with no build image | Listed versions only; another is a request to DevOps first |
| `group_id`, `artifact_id`, `nuget_name` as typed | Checked against `FIELD_RULES` on the form and at filing |
| Copied the reference app's files with whatever credential sat in them | A file carrying a literal value for a credential-named key stops the write (`credentialsIn`); placeholders, `{{ … }}` and vaulted values pass |
| Names like `prd_api` or `all`, and case-only duplicates, accepted | Refused: inventories would read them as an override or the project's own files |
| Copied a live reference application at every request: an edit or rename there changed or broke every pipeline after it, and its hostnames, ports and DB names came along | Templates imported once from the reference, checked by a person and saved in the portal, with every change kept; a reference changing later changes nothing |
| Namespace tokens written as `changeme` and left to memory; deploys failed until someone remembered | Still `changeme` (never a real token in inventories), but the completed request lists the tokens to set as an open follow-up |
| DBScripts skipped namespaces but Database_Microsoft did not | Every database skips them and gets `host_vars/localhost` |
| Replaced the reference app's name wherever it appeared in the copied text, hitting anything that contained it | `__APPLICATION__` marks where the name goes, put there once at import and checked before saving |
| Copied GAFI_Digital_Network's project files changing only `project_name`, and wrote `team.yml` only if that project had one | `__PROJECT__` in the template; `team.yml` always written |
| Ignored the auto-deploy answer: "false" for DEVdotNET, "true" for everyone else | The requester's answer is written, and the approver sees it |
| "Leave empty — default user will be used", then wrote `changeme` | The form says `changeme`, and the request lists it to set |
| Pushed inventories and ocp-templates separately, cleaning up local files on failure; one could land without the other | Both planned before either is pushed; each push carries the marker and a retry completes what is missing |
| Audit, history and ELK in files and best-effort calls | The request itself: who, what, when, the decision, the commit |
| Auto-deploy to QC as a string; a failed submit could pass silently | An explicit yes/no, and a request is filed in one transaction or not at all |
| Provisioning and the test build ran inside the approval call; a Jenkins hiccup there was a warning in a returned dict | Steps of their own, in the database, followed to a result, retried on their own; the request page shows each with its build |
| Approvers overrode names and YAML at approval, silently | Changes made before approving, each checked and recorded; the requester sees what was changed, by whom, from what |

**Every request is assessed for its approver** (`modules/requests/risk.ts`),
in the background the moment it is filed, and shown only to people who may
decide it — on the approval card, in the approve dialog when it is not low,
and in full on the request page ("Before you approve", with Assess again).
The **facts** are the portal's, checked in code: who gets access and whether
they are in the teams that own the project (`teamsOwning`, from the catalog);
whether that project deploys to `prd`/`prd_dr`; whether the requester is in
an owning team; near-duplicate names in ADO or Jira (`similar`: case,
punctuation, a suffix, a typo or two); and a reason under six words. The
**level** is the count of cautions — none, one, several: low, medium, high —
so it is testable and no model can talk it up or down. The **model** adds only
words: a one-line summary of those facts, and at most two notes on whether the
reason explains the request, labelled as its reading. Without Ollama, or when
it fails, the facts and the level still stand and the page says why there is
no summary. One row per request (`request_assessments`), replaced on Assess
again; the risk tests live in `requests.test.ts`, because that file deletes
every request, and take the catalog lock (4202) around their own system.

**Every request form has one shape** (`features/requests/form-layout.tsx`):
a header naming the kind and provider, the form as a card of numbered
sections (where, what, who, why), labels above and persistent help below,
`(optional)` on the optional fields rather than marks on required ones, each
live check answered under its own field (`CheckMessage`), a reason that warns
before it reads as thin (`ReasonField`, the same six words `modules/requests/risk.ts`
flags), and an action bar — Cancel then the primary, last — that names the
first thing still missing instead of a silently disabled button. Beside it a
sticky `ReviewPanel`: what is asked for, a readiness checklist with progress,
what happens next. A new form composes these; it does not lay itself out. The
request page leads with the kind and provider, the name large, and a
four-stage tracker (`stagesOf`); deciders get a decision card at the top, and
Withdraw sits in the header.

`check()` is what the form calls as someone types and what `submit()` runs, so
the two can never disagree. Name rules are in `modules/requests/rules.ts`, from the ADO
Server naming restrictions.

`integrations/ado/fake-server.ts` stands in for ADO Server in tests and local
development — including the sign-in page ADO returns instead of a 401, and the
queued operation behind project creation.

Group membership is found by `groupFilter()` in `integrations/ldap/groups.ts`.
An explicit `LDAP_GROUP_FILTER` wins; otherwise the server's rootDSE decides —
Active Directory gets the in-chain matching rule, because `memberOf` misses
nested groups, and OpenLDAP gets `groupOfNames`. It used to be a hardcoded
OpenLDAP default, and on AD that silently found no groups: nobody in DEVOPS
could approve anything. When the rootDSE is refused, an AD-style
`LDAP_USER_FILTER` is taken as the signal. The choice is pure
(`chooseGroupFilter`) so every branch is tested without an AD.

The UI decides whether to offer approvals from `GET /auth/profile`, read live
from the directory, not from the token's `roles` claim. A session that predates
a group change — or predates `roles` altogether — still shows the truth. The
profile page (`/me`) shows title, department, team (AD's `division`), manager
and groups, and when someone is not an approver it says what the directory
returned and how groups were looked up, rather than leaving them to guess.

Blank values in `.env` (`KEY=`) are treated as unset in `lib/config.ts`. Before
that, a `.env` copied from `.env.example` failed to boot on its blank
`ADO_PAT`.
