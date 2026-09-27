# e-IDP

An internal developer portal / self-service portal for the organization. Two
things it does:

## 1. Project map

A catalog of every project in the org, built by reading the **`inventories`** repo —
the single source of truth for what exists and how it is wired. e-IDP reads it
and renders the map; it does not own that data.

> Structure of `inventories` and how it is parsed: TBD.

## 2. Self-service requests

Developers ask for things instead of filing tickets or pinging platform:

- create a repo
- create a pipeline
- request access to a repo
- (more to come)

Each request is a tracked object with a lifecycle — submitted, approved,
executed — not a fire-and-forget script.

## Running it

```sh
pnpm install
pnpm dev
```

`pnpm dev` writes `.env` if it is missing, starts Postgres and OpenLDAP, and
runs both apps: the UI on http://localhost:5173 and the API on
http://localhost:3000.

Sign in as `alice` / `alicepw` or `bob` / `bobpw` — the test accounts in
`ldap/seed.ldif`.

| | |
|---|---|
| `pnpm dev` | everything up |
| `pnpm stop` | containers down, data kept |
| `pnpm reset` | containers down, **data wiped**, back up |
| `pnpm test` | API tests, needs the containers running |
| `pnpm build` | production build |

### With podman, no node needed

`scripts/dev.sh up` runs the whole thing in containers — Postgres, OpenLDAP,
the API and the UI — so nothing has to be installed on the machine but podman.
It reads the same `.env`, so one file configures everything.

```sh
./scripts/dev.sh up        # build and start everything
./scripts/dev.sh restart   # restart the apps, e.g. after editing .env
./scripts/dev.sh build     # rebuild the image after a dependency change
./scripts/dev.sh logs      # follow the api; pass a name for another
./scripts/dev.sh status
./scripts/dev.sh down      # stop, keep the data
./scripts/dev.sh reset     # stop, wipe volumes, start again
```

Then open http://localhost:5173. `apps/*/src` is mounted into the containers,
so edits reload in place without rebuilding.

To run only the backing services and the apps yourself with pnpm:

```sh
./scripts/dev.sh services
pnpm install && pnpm -r --parallel dev
```

Things worth knowing:

- Rootless podman cannot bind ports below 1024, so LDAP is published on
  **1389** rather than 389. The script prints the `LDAP_URL` to use and warns
  if `.env` still points at 389.
- Published ports are fixed when the pod is created, so changing
  `API_HOST_PORT` and friends needs a `down` first.
- If the browser stops reloading on a change, bind-mount file events are not
  arriving: `VITE_POLLING=1 ./scripts/dev.sh restart`.
- Dependencies are installed inside the image, so the host's `node_modules` is
  never used and `.env` is never copied into a layer.

## When a login fails

The API deliberately tells a caller nothing beyond "those credentials did not
work". To find out which stage actually failed:

```sh
pnpm --filter @eidp/api ldap:doctor <username> [password]
```

It reads the server's rootDSE first, so it names the product you are actually
talking to and lists the suffixes it serves — which are the valid values for
`LDAP_BASE_DN`. Then it reports the service bind, the account lookup and the
user's own password separately.

When the lookup finds nothing it searches again without assuming a schema,
prints what the account really looks like, and names the settings to use.
Active Directory needs

```sh
LDAP_USER_FILTER=(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))
```

where OpenLDAP needs `inetOrgPerson`/`uid`. `objectCategory=person` matters on
AD: `objectClass=user` also matches computer accounts.

## Building the project map

The map is built by syncing the `inventories` repo out of Azure DevOps Server.
Set these in `.env`, then restart the API or `POST /catalog/sync`:

```sh
ADO_BASE_URL=https://<host>/<collection>   # collection included
ADO_PAT=<personal access token, Code: Read>
INVENTORIES_PROJECT=<ADO project holding the repo>
```

Without them the API still runs; the project map reports that it cannot be
built and says which setting is missing.
