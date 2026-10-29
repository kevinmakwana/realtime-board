#!/usr/bin/env bash
# One-command public demo on a fresh Docker host: generates secrets, starts the stack with automatic HTTPS and
# loads the demo board. Safe to re-run: it keeps an existing deploy/.env.
#
#   ./deploy/demo-up.sh board.example.com        # a domain whose DNS already points at this host
#   ./deploy/demo-up.sh 203-0-113-7.sslip.io     # no domain? sslip.io resolves the dashed IP for free
#
# Dev sign-in is ON: anyone can sign in as anyone, so use it for fictional demo data only (see docs/deploy.md).
set -euo pipefail

DOMAIN="${1:?usage: $0 <domain>   (e.g. board.example.com or 203-0-113-7.sslip.io)}"
cd "$(dirname "$0")"
ENV_FILE=.env
COMPOSE=(docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE" --profile tls)

command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }
docker compose version >/dev/null || { echo "docker compose v2 is required" >&2; exit 1; }

if [ ! -f "$ENV_FILE" ]; then
  umask 077
  cat >"$ENV_FILE" <<ENV
WEB_ORIGIN=https://${DOMAIN}
DOMAIN=${DOMAIN}
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
POSTGRES_PASSWORD=$(openssl rand -hex 24)
AUTH_DEV_LOGIN=true
HTTP_PORT=8081
ENV
  echo "wrote deploy/.env"
else
  echo "keeping existing deploy/.env"
fi

# SKIP_PULL=1 reuses images already on the host (offline runs).
[ "${SKIP_PULL:-}" = 1 ] || "${COMPOSE[@]}" pull
"${COMPOSE[@]}" up -d --wait
# Idempotent enough for a demo: it adds one "Product Launch (demo)" board each time it runs, so only seed once.
if ! "${COMPOSE[@]}" exec -T postgres psql -U board -d board -tAc "select 1 from boards where name = 'Product Launch (demo)' limit 1" | grep -q 1; then
  "${COMPOSE[@]}" exec -T server-1 node dist/seed.js
fi

echo
echo "Ready: https://${DOMAIN}   (the first visit may take a few seconds while the certificate is issued)"
