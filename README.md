# e-IDP

An internal developer portal / self-service portal for the organization. Two
things it does:

## 1. Project map

A catalog of every project in the org, built by reading the **`engine`** repo —
the single source of truth for what exists and how it is wired. e-IDP reads it
and renders the map; it does not own that data.

> Structure of `engine` and how it is parsed: TBD.

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
