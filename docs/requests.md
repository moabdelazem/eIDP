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
  rule is the old `APP_NAME_REGEX`, at most 50. No technology is registered
  from it until the copy-and-patch is ported from `new_applications.py`, so
  nobody can file a request that cannot be written as the old portal would.
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
  account's PAT needs Code (read & write) on the inventories repository.
- `team.yml` is written the way the repository spells it — the auto-deploy
  flag quoted, an empty list as one empty item. The application's own files
  and the namespaces come from the registry's templates, ported from the old
  portal.

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
