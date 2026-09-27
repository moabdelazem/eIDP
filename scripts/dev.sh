#!/usr/bin/env bash
# Development environment for e-IDP under podman.
#
#   up        everything in containers: postgres, openldap, api, web
#   services  only postgres and openldap, for running the apps with pnpm
#
# Everything shares one pod, so the containers reach each other on localhost
# exactly as they would running natively. Reads .env from the repository root,
# so the same file configures the containers and the apps.
#
# Rootless podman cannot bind ports below 1024, so LDAP is published on 1389
# by default rather than 389. Set LDAP_HOST_PORT to override.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pod=eidp
env_file="$root/.env"

POSTGRES_IMAGE="${POSTGRES_IMAGE:-docker.io/library/postgres:17-alpine}"
OPENLDAP_IMAGE="${OPENLDAP_IMAGE:-docker.io/osixia/openldap:1.5.0}"
APP_IMAGE="${APP_IMAGE:-localhost/eidp-dev}"

note() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v podman >/dev/null || die "podman is not installed or not on PATH."

if [[ ! -f "$env_file" ]]; then
  note "No .env found; copying .env.example"
  cp "$root/.env.example" "$env_file"
fi

# Read .env as data. It must never be sourced: an Active Directory filter
# contains parentheses, which the shell parses as an array assignment and dies
# on before this script does anything at all.
env_value() {
  local value
  value="$(sed -n "s/^[[:space:]]*$1=//p" "$env_file" | tail -1)"
  # Tolerate quotes, though podman --env-file wants values unquoted.
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}

DATABASE_URL_ENV="$(env_value DATABASE_URL)"
LDAP_URL_ENV="$(env_value LDAP_URL)"
ADO_PAT="$(env_value ADO_PAT)"

# A URL that names this machine means "the container in this pod". Anything
# else is a real server the user configured, and must be left alone.
points_here() { [[ -z "$1" || "$1" == *localhost* || "$1" == *127.0.0.1* ]]; }

points_here "$DATABASE_URL_ENV" && USE_LOCAL_POSTGRES=1 || USE_LOCAL_POSTGRES=0
points_here "$LDAP_URL_ENV" && USE_LOCAL_LDAP=1 || USE_LOCAL_LDAP=0

# Take the credentials from DATABASE_URL so the container and the app cannot
# disagree about them.
POSTGRES_USER="${POSTGRES_USER:-eidp}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-eidp}"
POSTGRES_DB="${POSTGRES_DB:-eidp}"
if [[ "$DATABASE_URL_ENV" =~ ^postgres(ql)?://([^:]+):([^@]+)@[^/]+/([^?]+) ]]; then
  POSTGRES_USER="${BASH_REMATCH[2]}"
  POSTGRES_PASSWORD="${BASH_REMATCH[3]}"
  POSTGRES_DB="${BASH_REMATCH[4]}"
fi
POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-5432}"
LDAP_HOST_PORT="${LDAP_HOST_PORT:-1389}"
API_HOST_PORT="${API_HOST_PORT:-3000}"
WEB_HOST_PORT="${WEB_HOST_PORT:-5173}"
LDAP_ADMIN_PASSWORD="${LDAP_ADMIN_PASSWORD:-admin}"
LDAP_DOMAIN="${LDAP_DOMAIN:-eidp.local}"

# SELinux relabelling for bind mounts. Harmless where SELinux is not enforcing,
# and required on RHEL-family hosts, which an organisation machine often is.
mount_opt=":ro,Z"

running() { podman container exists "$1" 2>/dev/null && [[ "$(podman inspect -f '{{.State.Running}}' "$1")" == "true" ]]; }

services() {
  if podman pod exists "$pod" 2>/dev/null; then
    # Published ports are fixed when the pod is created, so changing a
    # *_HOST_PORT only takes effect after `down`.
    note "Pod $pod already exists; its published ports are unchanged."
  else
    note "Creating pod $pod (postgres :$POSTGRES_HOST_PORT, ldap :$LDAP_HOST_PORT)"
    podman pod create --name "$pod" \
      -p "$POSTGRES_HOST_PORT:5432" \
      -p "$LDAP_HOST_PORT:389" \
      -p "$API_HOST_PORT:3000" \
      -p "$WEB_HOST_PORT:5173" >/dev/null
  fi

  if [[ "$USE_LOCAL_POSTGRES" == 0 ]]; then
    note "DATABASE_URL points at $DATABASE_URL_ENV — not starting a postgres container"
  elif running "$pod-postgres"; then
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

  if [[ "$USE_LOCAL_LDAP" == 0 ]]; then
    note "LDAP_URL points at $LDAP_URL_ENV — not starting an openldap container"
  elif running "$pod-openldap"; then
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

  [[ "$USE_LOCAL_POSTGRES" == 1 ]] && wait_for_postgres
  [[ "$USE_LOCAL_LDAP" == 1 ]] && ensure_ldap_seed
  return 0
}

up() {
  services
  build_image
  start_apps
  report_apps
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

build_image() {
  if [[ -n "$(podman images -q "$APP_IMAGE" 2>/dev/null)" && "${REBUILD:-}" != "1" ]]; then
    note "Using existing image $APP_IMAGE (REBUILD=1 to rebuild)"
    return 0
  fi
  note "Building $APP_IMAGE"
  podman build -f "$root/Containerfile.dev" -t "$APP_IMAGE" "$root"
}

# Inside the pod the containers share a network namespace, so a service in the
# pod is reached on its *container* port, not the published host port. Only
# rewrite a URL that points at this machine: one naming a real server is the
# user's configuration and overriding it silently sends the app somewhere it
# was never told to go.
in_pod_env=(-e "INVENTORIES_CHECKOUT=/app/.cache/inventories")
if [[ "$USE_LOCAL_POSTGRES" == 1 ]]; then
  in_pod_env+=(-e "DATABASE_URL=postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:5432/$POSTGRES_DB")
fi
if [[ "$USE_LOCAL_LDAP" == 1 ]]; then
  in_pod_env+=(-e "LDAP_URL=ldap://localhost:389")
fi

start_apps() {
  podman rm -f "$pod-api" "$pod-web" >/dev/null 2>&1 || true

  note "Starting api"
  podman run -d --pod "$pod" --name "$pod-api" \
    --env-file "$env_file" \
    "${in_pod_env[@]}" \
    -v "$root/apps/api/src:/app/apps/api/src:Z" \
    -v "$pod-checkout:/app/.cache" \
    "$APP_IMAGE" pnpm --filter @eidp/api dev >/dev/null

  note "Starting web"
  podman run -d --pod "$pod" --name "$pod-web" \
    -e "VITE_POLLING=${VITE_POLLING:-}" \
    -v "$root/apps/web/src:/app/apps/web/src:Z" \
    -v "$root/apps/web/index.html:/app/apps/web/index.html:Z" \
    "$APP_IMAGE" pnpm --filter @eidp/web dev >/dev/null

  note "Waiting for the api"
  for _ in $(seq 1 30); do
    if curl -fsS "http://localhost:$API_HOST_PORT/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  warn "The api did not answer on :$API_HOST_PORT. Check: $0 logs $pod-api"
}

report_apps() {
  echo
  note "e-IDP is up:"
  echo
  echo "  web   http://localhost:$WEB_HOST_PORT"
  echo "  api   http://localhost:$API_HOST_PORT/health"
  echo
  echo "  directory  ${LDAP_URL_ENV:-(unset)}$([[ "$USE_LOCAL_LDAP" == 1 ]] && echo '  [bundled container]')"
  echo "  database   ${DATABASE_URL_ENV:-(unset)}$([[ "$USE_LOCAL_POSTGRES" == 1 ]] && echo '  [bundled container]')"
  echo
  echo "  Source under apps/*/src is mounted, so edits reload in place."
  echo "  Set VITE_POLLING=1 if the browser stops reloading on a change."
  echo
  if [[ -z "${ADO_PAT:-}" ]]; then
    warn "ADO_PAT is empty, so the project map will report that it cannot be built."
    warn "Set ADO_BASE_URL, ADO_PAT and INVENTORIES_PROJECT in $env_file, then: $0 restart"
  fi
}

restart_apps() {
  start_apps
  report_apps
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
  if [[ "$USE_LOCAL_LDAP" == 1 && "$LDAP_HOST_PORT" != "389" && "$LDAP_URL_ENV" == *":389" ]]; then
    warn "Your .env points LDAP_URL at :389, but the container is published on :$LDAP_HOST_PORT."
    warn "That only matters for apps run with pnpm; inside the pod :389 is correct."
  fi
  if [[ -z "${ADO_PAT:-}" ]]; then
    warn "ADO_PAT is empty, so the project map cannot be built. Set ADO_BASE_URL, ADO_PAT and INVENTORIES_PROJECT in .env."
  fi
  note "Then run the apps against them:  pnpm install && pnpm -r --parallel dev"
  note "Or run them in containers instead:  $0 up"
}

down() {
  note "Stopping pod $pod (volumes kept)"
  podman pod exists "$pod" 2>/dev/null && podman pod rm -f "$pod" >/dev/null || true
  note "Done. Data is preserved in volumes $pod-pgdata, $pod-ldapdata, $pod-ldapconfig."
}

reset() {
  down
  note "Removing volumes"
  for volume in "$pod-pgdata" "$pod-ldapdata" "$pod-ldapconfig" "$pod-checkout"; do
    podman volume rm "$volume" >/dev/null 2>&1 || true
  done
  up
}

status() {
  podman pod exists "$pod" 2>/dev/null || { echo "pod $pod does not exist"; return 0; }
  podman ps --pod --filter "pod=$pod" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
}

logs() { podman logs -f "${1:-$pod-api}"; }

case "${1:-up}" in
  up)       up ;;
  services) services; report ;;
  restart)  restart_apps ;;
  build)    REBUILD=1 build_image ;;
  down)     down ;;
  reset)    reset ;;
  status)   status ;;
  logs)     shift; logs "${1:-}" ;;
  *)        die "usage: $0 [up|services|restart|build|down|reset|status|logs <container>]" ;;
esac
