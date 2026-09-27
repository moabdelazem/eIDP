# e-IDP

Internal developer portal: a project map sourced from the `engine` repo, plus
self-service requests (create repo, create pipeline, request repo access).
See README.md for the product shape.

## Layout

pnpm workspace. `apps/*` and `packages/*`.

- `apps/api` — Hono API (`@eidp/api`).
- `apps/web` — Vite + React UI (`@eidp/web`). Dev server proxies `/api` to
  the API on :3000.
  `src/components/dashboard.tsx` is the signed-in shell: shadcn sidebar plus
  a view switcher. The sidebar collapses to an icon rail (`collapsible="icon"`),
  and the provider reads the `sidebar_state` cookie back itself — shadcn only
  writes it, since Next reads it server-side. No router yet — views are local
  state. Add one when a project needs its own URL.

## Stack

- Node 24 — runs `.ts` directly via native type stripping. No tsx, no build
  step, no ts-node. `erasableSyntaxOnly` is on: no enums, no parameter
  properties, no namespaces.
- Hono + `@hono/node-server`.
- React 19, Vite, Tailwind v4 (`@tailwindcss/vite`, no config file — tokens
  live in `src/index.css`), shadcn/ui new-york. shadcn 4.x imports `cn` from
  the `cn` package and Radix from the unified `radix-ui` package, so there is
  no `src/lib/utils.ts`.
- Postgres 17 and OpenLDAP via `compose.yaml`. Creds in `.env.example`.
  LDAP base DN is `dc=eidp,dc=local`.

## Design

Eggplant is the ground, red is the signal — if something is red it is an
action or it wants attention, never decoration. The app chrome (`--rail`)
stays dark eggplant; `--background` is paper. The shadcn `--sidebar-*`
tokens point at the rail, so the sidebar is the rail. `shadcn add` writes
its own neutral values into `src/index.css` — check them after adding any
component and point them back at the rail.

Light is the only theme in use — `<html>` carries no `dark` class. The `.dark`
token block in `src/index.css` is kept and works, but nothing switches to it
yet. Design and check against light.

Archivo for UI, JetBrains Mono for identifiers the user can copy (repo paths,
DNs, pipeline ids) and nothing else.

`apps/web/src/assets/logo.png` is the logo the app uses: the supplied mark
with its baked `rgb(240,243,250)` background knocked out and the padding
trimmed, so it sits on the eggplant rail and on paper without a visible box.
`logo-source.png` beside it is the untouched original. Replacing the logo
means repeating that knockout, or supplying one with real transparency.

## Auth

LDAP is the auth service. `apps/api/src/ldap.ts` service-binds, searches for
the uid, then re-binds as that user's DN to verify the password — the uid is
never assumed to map to a DN pattern.

`POST /auth/login` returns an 8h HS256 JWT (`hono/jwt`, no extra dep);
`hono/jwt` middleware guards protected routes. `JWT_SECRET` is required at
boot.

Test users live in `ldap/seed.ldif` (alice/alicepw, bob/bobpw), mounted into
the container's bootstrap dir so a fresh volume gets them. `pnpm --filter
@eidp/api test` runs against the live container.

## Commands

```sh
pnpm dev                           # .env + containers + both apps
pnpm test                          # all package tests
pnpm --filter @eidp/api dev        # watch mode
pnpm --filter @eidp/api typecheck  # tsc --noEmit
pnpm --filter @eidp/api test       # needs openldap up
pnpm --filter @eidp/web dev        # http://localhost:5173
pnpm --filter @eidp/web build      # tsc -b && vite build
docker compose up -d
```

## Notes

- `engine` is read-only input. e-IDP never writes back to it.
- Don't add a dependency for something Node 24 or Hono already does.
