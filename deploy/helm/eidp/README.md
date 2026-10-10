# e-IDP Helm chart

The portal on Kubernetes: the API, the web app and, for dev and test
clusters, a Postgres of its own — reached through a Gateway API `HTTPRoute`
on an Envoy Gateway. Why it is shaped this way is in
[`docs/deploy.md`](../../../docs/deploy.md).

## Before installing

1. **Images.** Build and push both, from the repository root:

   ```sh
   docker build -f apps/api/Containerfile -t <registry>/eidp-api:<tag> .
   docker build -f apps/web/Containerfile -t <registry>/eidp-web:<tag> .
   ```

   and set `api.image` / `web.image` (or keep the defaults and push there).
2. **A Gateway.** Envoy Gateway running, with a `Gateway` whose listener
   allows routes from this namespace. Name it in `httpRoute.parentRefs`.
3. **Secrets**, in Vault or a Kubernetes Secret (or both: Vault wins). The
   API needs at least `DATABASE_URL` (unless `postgresql.enabled`),
   `LDAP_BIND_PASSWORD`, and the token of each integration it should use —
   `ADO_PAT`, `JIRA_TOKEN`, `JENKINS_TOKEN`. `JWT_SECRET` is generated if
   neither has one.

## Install

A dev cluster, everything in the chart, secrets in one Secret:

```sh
kubectl create namespace eidp
kubectl -n eidp create secret generic eidp-env \
  --from-literal=LDAP_BIND_PASSWORD=... \
  --from-literal=ADO_PAT=...
helm install portal deploy/helm/eidp -n eidp \
  --set postgresql.enabled=true \
  --set api.secrets.existingSecret=eidp-env \
  --set 'httpRoute.hostnames[0]=portal.dev.example.com' \
  -f my-settings.yaml          # api.config: LDAP_URL, ADO_BASE_URL, …
helm test portal -n eidp
```

Production, an external database and Vault (AppRole):

```yaml
# values-prod.yaml
api:
  image: { repository: registry.example.com/eidp-api, tag: "2026.10.1" }
  config:
    LDAP_URL: ldaps://dc01.example.com:636
    LDAP_BASE_DN: dc=example,dc=com
    LDAP_BIND_DN: svc-eidp@example.com
    ADO_BASE_URL: https://ado.example.com/DefaultCollection
    INVENTORIES_PROJECT: Platform
    JENKINS_URL: https://jenkins.example.com
    JENKINS_USER: svc-eidp
  vault:
    addr: https://vault.example.com:8200
    secretPaths: eidp/api
    required: true
    auth: { existingSecret: eidp-vault-approle }   # VAULT_ROLE_ID, VAULT_SECRET_ID
  inventories:
    persistence: { enabled: true, storageClass: nfs-rwx }
web:
  image: { repository: registry.example.com/eidp-web, tag: "2026.10.1" }
httpRoute:
  parentRefs: [{ name: public, namespace: envoy-gateway-system, sectionName: https }]
  hostnames: [portal.example.com]
networkPolicy: { enabled: true, gatewayNamespace: envoy-gateway-system }
```

```sh
helm upgrade --install portal deploy/helm/eidp -n eidp -f values-prod.yaml
```

## Values

The commented [`values.yaml`](values.yaml) is the reference; a schema
(`values.schema.json`) refuses a secret put in `api.config`, a Postgres
password that would break the connection URL, and an `HTTPRoute` with no
Gateway to attach to.

| Key | What it is |
|---|---|
| `api.config` | Non-secret settings by their `.env.example` names, as a ConfigMap |
| `api.secrets.existingSecret` | A Secret of settings (`LDAP_BIND_PASSWORD`, `ADO_PAT`, …) — the cluster's `.env` |
| `api.secrets.generateJwtSecret` | Make `JWT_SECRET` once and keep it (default on) |
| `api.vault.*` | Vault address, paths, KV mount/version, namespace, `required`, and the Secret holding a token or AppRole |
| `api.inventories.persistence` | Keep the inventories checkout on a ReadWriteMany claim instead of re-cloning after a restart |
| `api.replicaCount`, `api.autoscaling` | Several replicas are safe: migrations and jobs coordinate through Postgres |
| `httpRoute.*` | Gateway, hostnames, `/api` request timeout, and the streaming paths with none |
| `database.external.existingSecret` | A Secret with `DATABASE_URL`, when it is not in Vault or `api.secrets` |
| `postgresql.enabled` | The chart's own single Postgres, for dev and test only |
| `networkPolicy.enabled` | Only the Gateway's namespace reaches the pods; only the API reaches Postgres |
