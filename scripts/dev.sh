#!/usr/bin/env bash
# Development services for e-IDP under podman.
#
# Runs Postgres and OpenLDAP in a pod so the API and UI can be run natively
# against them with `pnpm dev`. Reads .env from the repository root, so the
# same file configures the containers and the apps.
#
# Rootless podman cannot bind ports below 1024, so LDAP is published on 1389
# by default rather than 389. Set LDAP_HOST_PORT to override.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pod=eidp
env_file="$root/.env"

POSTGRES_IMAGE="${POSTGRES_IMAGE:-docker.io/library/postgres:17-alpine}"
OPENLDAP_IMAGE="${OPENLDAP_IMAGE:-docker.io/osixia/openldap:1.5.0}"

note() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v podman >/dev/null || die "podman is not installed or not on PATH."

if [[ ! -f "$env_file" ]]; then
  note "No .env found; copying .env.example"
  cp "$root/.env.example" "$env_file"
fi

# Load .env so the containers and the apps agree on credentials. `set -a`
# exports every assignment; anything already in the environment wins, which is
# what lets POSTGRES_IMAGE and friends be overridden on the command line.
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

POSTGRES_USER="${POSTGRES_USER:-eidp}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-eidp}"
POSTGRES_DB="${POSTGRES_DB:-eidp}"
POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-5432}"
LDAP_HOST_PORT="${LDAP_HOST_PORT:-1389}"
LDAP_ADMIN_PASSWORD="${LDAP_ADMIN_PASSWORD:-admin}"
LDAP_DOMAIN="${LDAP_DOMAIN:-eidp.local}"

# SELinux relabelling for bind mounts. Harmless where SELinux is not enforcing,
# and required on RHEL-family hosts, which an organisation machine often is.
mount_opt=":ro,Z"

running() { podman container exists "$1" 2>/dev/null && [[ "$(podman inspect -f '{{.State.Running}}' "$1")" == "true" ]]; }

up() {
  podman pod exists "$pod" 2>/dev/null || {
    note "Creating pod $pod (postgres :$POSTGRES_HOST_PORT, ldap :$LDAP_HOST_PORT)"
    podman pod create --name "$pod" \
      -p "$POSTGRES_HOST_PORT:5432" \
      -p "$LDAP_HOST_PORT:389" >/dev/null
  }

  if running "$pod-postgres"; then
    note "postgres already running"
  else
    podman rm -f "$pod-postgres" >/dev/null 2>&1 || true
    note "Starting postgres"
    podman run -d --pod "$pod" --name "$pod-postgres" \
      -e POSTGRES_USER="$POSTGRES_USER" \
      -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
      -e POSTGRES_DB="$POSTGRES_DB" \
      -v "$pod-pgdata:/var/lib/postgresql/data" \
      "$POSTGRES_IMAGE" >/dev/null
  fi

  if running "$pod-openldap"; then
    note "openldap already running"
  else
    podman rm -f "$pod-openldap" >/dev/null 2>&1 || true
    note "Starting openldap"
    podman run -d --pod "$pod" --name "$pod-openldap" \
      -e LDAP_ORGANISATION="eIDP" \
      -e LDAP_DOMAIN="$LDAP_DOMAIN" \
      -e LDAP_ADMIN_PASSWORD="$LDAP_ADMIN_PASSWORD" \
      -v "$root/ldap/seed.ldif:/container/service/slapd/assets/config/bootstrap/ldif/custom/seed.ldif$mount_opt" \
      -v "$pod-ldapdata:/var/lib/ldap" \
      -v "$pod-ldapconfig:/etc/ldap/slapd.d" \
      "$OPENLDAP_IMAGE" --copy-service >/dev/null
  fi

  wait_for_postgres
  ensure_ldap_seed
  report
}

wait_for_postgres() {
  note "Waiting for postgres"
  for _ in $(seq 1 30); do
    if podman exec "$pod-postgres" pg_isready -U "$POSTGRES_USER" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  die "postgres did not become ready. Check: $0 logs"
}

# The bootstrap LDIF is only applied when the data volume is first created, so
# a pre-existing volume needs the entries added explicitly.
ensure_ldap_seed() {
  local base="dc=${LDAP_DOMAIN//./,dc=}"
  for _ in $(seq 1 30); do
    if podman exec "$pod-openldap" ldapsearch -x -H ldap://localhost \
        -b "$base" -D "cn=admin,$base" -w "$LDAP_ADMIN_PASSWORD" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if podman exec "$pod-openldap" ldapsearch -x -H ldap://localhost \
      -b "ou=people,$base" -D "cn=admin,$base" -w "$LDAP_ADMIN_PASSWORD" >/dev/null 2>&1; then
    note "ldap already seeded"
    return 0
  fi

  note "Seeding ldap from ldap/seed.ldif"
  podman exec -i "$pod-openldap" ldapadd -x -D "cn=admin,$base" -w "$LDAP_ADMIN_PASSWORD" \
    < "$root/ldap/seed.ldif" >/dev/null
}

report() {
  local base="dc=${LDAP_DOMAIN//./,dc=}"
  echo
  note "Services are up. Put these in $env_file if they are not already:"
  cat <<EOF

  DATABASE_URL=postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:$POSTGRES_HOST_PORT/$POSTGRES_DB
  LDAP_URL=ldap://localhost:$LDAP_HOST_PORT
  LDAP_BASE_DN=$base
  LDAP_BIND_DN=cn=admin,$base

EOF
  if [[ "$LDAP_HOST_PORT" != "389" ]] && grep -q 'LDAP_URL=ldap://localhost:389$' "$env_file" 2>/dev/null; then
    warn "Your .env still points LDAP_URL at :389, but the container is published on :$LDAP_HOST_PORT."
  fi
  if [[ -z "${ADO_PAT:-}" ]]; then
    warn "ADO_PAT is empty, so the project map cannot be built. Set ADO_BASE_URL, ADO_PAT and INVENTORIES_PROJECT in .env."
  fi
  note "Then run the apps against them:  pnpm install && pnpm -r --parallel dev"
}

down() {
  note "Stopping pod $pod (volumes kept)"
  podman pod exists "$pod" 2>/dev/null && podman pod rm -f "$pod" >/dev/null || true
  note "Done. Data is preserved in volumes $pod-pgdata, $pod-ldapdata, $pod-ldapconfig."
}

reset() {
  down
  note "Removing volumes"
  for volume in "$pod-pgdata" "$pod-ldapdata" "$pod-ldapconfig"; do
    podman volume rm "$volume" >/dev/null 2>&1 || true
  done
  up
}

status() {
  podman pod exists "$pod" 2>/dev/null || { echo "pod $pod does not exist"; return 0; }
  podman ps --pod --filter "pod=$pod" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
}

logs() { podman logs -f "${1:-$pod-postgres}"; }

case "${1:-up}" in
  up)     up ;;
  down)   down ;;
  reset)  reset ;;
  status) status ;;
  logs)   shift; logs "${1:-}" ;;
  *)      die "usage: $0 [up|down|reset|status|logs <container>]" ;;
esac
