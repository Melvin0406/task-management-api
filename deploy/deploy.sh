#!/usr/bin/env bash
# Deploy or update the running stack. Run from the repo root on the server.
#   bash deploy/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.prod.yml"

echo "==> pulling latest code"
git pull --ff-only

echo "==> building and starting"
$COMPOSE up -d --build

echo "==> waiting for the database"
until $COMPOSE exec -T mysql mysqladmin ping -h 127.0.0.1 --silent 2>/dev/null; do
  sleep 3
done

echo "==> applying migrations"
# Runs inside the api container so it uses the compose network and the same
# environment the app itself sees.
$COMPOSE exec -T api npm run migrate:prod

echo "==> health check"
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then
    curl -sS http://127.0.0.1:3000/health
    echo
    echo "Deploy OK"
    exit 0
  fi
  sleep 2
done

echo "Health check failed. Recent logs:" >&2
$COMPOSE logs --tail=50 api >&2
exit 1
