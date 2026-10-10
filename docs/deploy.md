# Deploying on Kubernetes

The chart is `deploy/helm/eidp` (its README says how to install it); the
images are `apps/api/Containerfile` and `apps/web/Containerfile`, built from
the repository root. Moved here: why it is shaped as it is, and its traps.

**Two images, no build step for the API.** The API image is Node 24 running
`src/*.ts` as it is (type stripping), production dependencies only
(`pnpm install --prod --filter @eidp/api...`), plus `git` — the catalog sync
clones the inventories repo — and `tini`, so SIGTERM reaches Node on a
rollout. `@eidp/contracts` is imported with `import type` only and never
loaded, so its link in the image dangles on purpose. The web image is the
Vite build under `nginx-unprivileged` on 8080: assets cached a year (their
names are hashed), `index.html` never (it is what points at a build), every
other path to `index.html` for React Router — except a missing file under
`/assets/`, which stays a 404, because that is how `lazyPage` learns a
deploy happened and reloads the tab.

**The way in is one HTTPRoute** on Envoy Gateway. `/api` goes to the API
with the prefix taken off — the API's routes are at its root, exactly as the
Vite dev server proxies it — and everything else to the web app, so nginx
proxies nothing. Envoy's default route timeout is 15 s, shorter than some
calls, so `/api` gets `httpRoute.timeouts.api` (60 s); the chatbot's answer
streams as server-sent events for as long as the model takes, so
`/api/chatbot/ask` is its own rule with the request timeout off (`0s`), and
any other streaming path is added to `httpRoute.streamingPaths`. The longer
prefix wins, so the streaming rule is matched before `/api`.

**Several API replicas are safe**, which is why the defaults run two:
migrations take advisory lock 4201, background jobs claim leases in
`job_runs` so each runs in one pod per interval, and a request being created
heartbeats so a pod restarting never fails another pod's work
(`docs/platform.md`). Sessions are HS256 JWTs, so every pod needs the same
`JWT_SECRET`: the chart generates one into `<release>-eidp-api-generated`
and keeps it across upgrades (`lookup`) and uninstalls
(`helm.sh/resource-policy: keep`) — a new one would sign everyone out. Still
per pod, and fine at that: the directory-group cache, the Jenkins queue
cache, kept log tails and the chatbot's one-answer-at-a-time.

**Secrets: Vault, then Secrets, then nothing in a ConfigMap.** The API reads
Vault at boot and what it reads wins over its environment
(`docs/integrations.md`), so the chart passes Vault's address and the
token or AppRole (from a Secret) and lets the app do it; Kubernetes Secrets
are the fallback, its `.env`. Environment sources, later winning: the
ConfigMap (`api.config`), the generated JWT secret, `api.secrets.existingSecret`
— and an explicit `env` (the database URL, Vault's credentials) over all of
those. `values.schema.json` refuses a secret-named key in `api.config`.

**The database is external** unless `postgresql.enabled`, which runs one
`postgres:17-alpine` StatefulSet for dev and test: `PGDATA` one directory
below the mount (a fresh volume's `lost+found` makes initdb refuse), its
password generated and kept, `DATABASE_URL` composed with Kubernetes'
`$(POSTGRES_PASSWORD)` expansion — so the password must be URL-safe, which
the schema checks.

**Locked down by default.** Every pod passes the `restricted` Pod Security
Standard: non-root, a read-only root filesystem (writable `/tmp`, nginx's
cache, the inventories checkout and Postgres' run directory are volumes), no
capabilities, RuntimeDefault seccomp, no service-account token — the API
never calls Kubernetes. `HOME=/tmp` in the API image, because git reads its
config from there. `networkPolicy.enabled` admits only the Gateway's
namespace to the pods and only the API to Postgres; egress stays open, since
the API's dependencies are wherever the organization runs them.

**Checked with** `helm lint`, `helm template` in several configurations, and
`kubeconform -strict` against Kubernetes 1.30 and the Gateway API CRD schema.
`helm test` asks `/health`, `/health/jobs` (which needs Postgres) and the
web app from inside the namespace.
