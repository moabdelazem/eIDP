# Running it in containers

`scripts/dev.sh`, the dev image, and why the api watches a directory. Moved out of CLAUDE.md, which keeps the rules that break things and points here.

`scripts/dev.sh up` runs everything under podman in one pod: Postgres,
OpenLDAP, api and web. Because they share a network namespace, the app
containers reach the services on the *container* ports (5432, 389), not the
published host ports — the script passes `DATABASE_URL` and `LDAP_URL`
overrides that win over `.env`.

The api runs with `node --watch-path=src`, not `--watch`: `--watch` follows
individual files, and `git pull` replaces files rather than editing them, so
after a pull the api kept serving the old code — a new route answered as the
old `/:id` route's 404. Watching the directory catches replaced files. If an
api still looks stale, `scripts/dev.sh restart`.

`Containerfile.dev` installs dependencies into the image and only source is
bind-mounted, so the container never sees the host's `node_modules`. The
image is labelled with `pnpm-lock.yaml`'s hash and `up`/`restart` rebuild it
when the lockfile changes — a pull that added a package used to leave a stale
image that could not import it. It also
installs `git`, which the catalog sync shells out to and the base image lacks.
`.containerignore` keeps `.env` out of the image layers.
