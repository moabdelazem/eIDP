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

## Trying pipeline requests locally

Pipeline requests can be tried end to end with no real Azure DevOps,
Jenkins or inventories:

```sh
pnpm --filter @eidp/api ado:fake        # Azure DevOps on :4010
pnpm --filter @eidp/api jenkins:fake    # Jenkins on :4030
pnpm --filter @eidp/api pipelines:dev   # once; add what it prints to .env, then start the API
```

`pipelines:dev` (`apps/api/scripts/pipelines-dev.ts`) makes two local git
repositories under `apps/api/.cache/dev-git`:
- **inventories:** the parser's fixtures, plus the reference applications the
  .NET and new-project templates come from;
- **ocp-templates:** the .NET manifests' reference.

It then saves the .NET-on-OpenShift, manifests and new-project templates by
importing them, as DevOps would on the Pipeline templates page. The catalog
sync reads `INVENTORIES_GIT_URL` when it is set, so the map shows what
approvals push.

The fake Azure DevOps gives every repository a first commit on `main`, so
its branches can be made, unless the repository's name contains "empty".
The fake Jenkins starts what the portal queues after a few seconds and ends
it a little later. It makes the application's job
(`<project>/<application>/develop`) when the first build is asked of it.

To try failures:
- ask for a repository with "empty" in its name: making its branches fails
  until it has a commit;
- put "fail" in the application's name: its first test build fails.

A walk-through:
1. As bob, ask for a repository in AgriLand.
2. As alice, approve it.
3. As bob, open the repository request and choose **Set up its pipeline**,
   then file a .NET Core pipeline.
4. As alice, **Adjust** it, or edit a file under *What approving writes*,
   then approve.
5. Follow its branches and its first test build on the request page.

Delete `apps/api/.cache/dev-git` to start over.
