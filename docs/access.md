# Who may do what

Permissions, roles and bindings; viewing as someone; the Access page; and the three layers that enforce it. Moved out of CLAUDE.md, which keeps the rules that break things and points here.

`services/rbac.ts` is the whole model, in three layers:

| Layer | What | Where |
|---|---|---|
| **Permission** | one thing the portal can do (`requests.decide`, `rbac.manage`, …) | `PERMISSIONS`, in code |
| **Role** | a named bundle of permissions (`member`, `team-lead`, `approver`, `pipeline-operator`, `build-operator`, `devops-admin`) | `ROLES`, in code |
| **Binding** | a directory group or one user → a role, everywhere or limited to a `team` or `project` | `rbac_bindings`, managed on the Access page (`/access`) |

Two bindings are **built in** and are not rows: everyone is a `member`
(`catalog.view`, `requests.create` — anyone in AD can sign in and use the
portal), and `APPROVER_GROUP` is `devops-admin`. Being code, they cannot be
removed from the page, so nobody can lock the portal out of its own admin.

`accessOf(uid)` asks the directory for the person's groups (cached per process
for `GROUP_CACHE_MS`, a minute — a removal from a group lands within it) and
reads their bindings fresh on every check, so a change on the Access page
applies immediately. Expired bindings count for nothing. A binding whose role
has been deleted from code grants nothing and is listed on the page as such.

- **A grant to one person needs a reason**, and may carry an expiry. It is the
  replacement for the old portal's `VALID_USERS`; the group is the normal case.
- **Scope.** A `project` scope matches the ADO project by name. A `team` scope
  matches the owning teams the catalog read from each system's `project.yml`
  (`teamsOwning`), so a lead of `DEVJAVA` decides access to every project
  DEVJAVA owns in any environment. A scoped grant is never global.
- **Team leads decide access requests only.** Creating a repository or project
  stays with `requests.decide`. A lead's approvals queue (`listPool`) holds
  only what they may decide, and `GET /requests/:id` returns `canDecide` so the
  UI never has to guess at scope.
- **Every grant and removal is audited** (`rbac_audit`, append-only), and
  `GET /rbac/explain/:uid` answers "why can bob approve?" with the group or
  binding behind each permission. The RBAC tests make and remove bindings on
  `dave` only and delete their own audit rows, because they share the dev
  database with real use.
- **The old portal's map** (`VALID_GROUPS`/`VALID_USERS`) comes across with
  `pnpm --filter @eidp/api rbac:import rbac.py` — a dry run that prints what it
  would add and what it leaves out and why; `--apply` writes it. `X-Lead`
  becomes a `team-lead` binding scoped to team X; roles for features e-IDP does
  not have are left out rather than carried as dead names.

**Viewing as someone else** (`rbac.view_as`, DevOps admins): `POST
/auth/assume` returns a one-hour session as the target whose token carries an
`act` claim (RFC 8693's actor) naming the admin. `requireAuth` holds such a
session to two rules on every request: anything but GET/HEAD is refused
(`viewing_as`), and it dies (`view_as_revoked`, 401) the moment the admin no
longer holds `rbac.view_as`. It is read-only by design — seeing what someone
sees, never acting as them; a request form's live check is a POST, so forms
cannot even be submitted. Each use is audited (`rbac_audit.action = 'assume'`,
with `target`). The browser keeps the admin's own token aside
(`tokenStore.assume`); a 401 during a view returns to it instead of signing
out, and switching either way reloads from `/`, because every cached resource
belonged to the other identity. `ViewingAsBanner` stays across the top in red
the whole time.

**The Access page** (`features/admin/`) is a working tool, its tab and
filters in the URL (`?tab=check&uid=bob`, `?status=expiring`). Across the
top: bindings to groups and to people, what expires within `EXPIRING_DAYS`
(14), and what needs cleaning up — an expired binding grants nothing but stays
listed, and one whose role left the code is "Role gone" — with a callout that
filters to them. **Bindings** is a table to work in: search, group/person,
role and status filters, sortable columns, select several to remove at once,
and a row menu — check the person, edit the reason and expiry (`PATCH
/rbac/bindings/:id`, audited as `update` with the binding as it was in
`previous`; who, role and scope never change, that is a new binding), grant
the same to someone else, remove. A role's name opens a hover card of what it
allows. **Granting** is a side sheet: group or person (a person checked
against the directory as typed), the role as cards with their permissions,
where (typeahead from `GET /rbac/suggestions`: the catalog's teams and
projects, and groups already bound), why, and an expiry from presets or a
day; a sentence at the foot says what will be granted. **Check someone**,
**Roles** (one grid, roles against permissions, each column opening its
bindings) and the **Audit log** (by day, filtered by action and searched)
are tabs. shadcn's registry is blocked by the environment's network policy,
so `checkbox.tsx` and `hover-card.tsx` were written from shadcn's source, as
`collapsible.tsx` was. Inside a dialog, anything that opens on focus (a hover
card) must not be the first focusable thing, or it opens over the dialog. The
tab contents are a `minmax(0,1fr)` grid, so a wide table scrolls in its box
instead of widening the page.

Three layers enforce it, and only the last one is security:

1. **Sidebar** — `components/sidebar/nav-manage.tsx` lists each `manageItems`
   entry (`app/nav.ts`) only once the profile confirms its permission.
2. **Route** — `app/require-permission.tsx` wraps each path, so opening one by
   link shows a refusal and nothing behind it mounts or fetches.
3. **API** — `requirePermission(p)` in `middleware/auth.ts`; `{ scoped: true }`
   admits anyone holding it anywhere and leaves the per-item call to the
   service, which reads the caller's access through `accessFrom(c)`.

A validly signed token claiming `approver` for someone without the permission
gets 403 everywhere, which `routes/rbac.test.ts` checks.

**Adding a guarded page means four edits, or it leaks:** the item in
`manageItems` with its permission, its route inside a matching
`<RequirePermission>`, `requirePermission` on its API endpoints, and those
endpoints in the `DEVOPS_ONLY` list in `routes/rbac.test.ts`. A new capability
is a new member of `Permission` in `packages/contracts/src/rbac.ts` and its
entry in `PERMISSIONS` — which is `satisfies Record<Permission, string>`, so
one without the other does not compile — added to the roles that should hold it.
`grep -rn requirePermission apps/api/src/routes` lists the whole guarded
surface.
