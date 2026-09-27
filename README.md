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

### On a machine with podman

`scripts/dev.sh` is the podman equivalent of `compose.yaml` — it runs Postgres
and OpenLDAP in a pod and reads the same `.env`, so you can run the apps
natively against them on your organization network.

```sh
./scripts/dev.sh up       # start, wait for readiness, seed LDAP
./scripts/dev.sh status
./scripts/dev.sh down     # stop, keep the data
./scripts/dev.sh reset    # stop, wipe volumes, start again
pnpm install && pnpm -r --parallel dev
```

Rootless podman cannot bind ports below 1024, so LDAP is published on **1389**
rather than 389. The script prints the `LDAP_URL` to use and warns if `.env`
still points at 389.

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
