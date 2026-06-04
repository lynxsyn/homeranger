#!/usr/bin/env bash
#
# homeranger dev stack — one command to bring up the whole local environment.
#
# Idempotent + re-runnable: already-healthy docker containers are left running
# (never restarted), the prisma client is regenerated, only PENDING migrations
# are applied, and the seed is an upsert (safe to repeat). Then the api, worker,
# scheduler, and web dev servers run together; Ctrl-C stops everything.
#
# Wired to `pnpm dev`. The apps read ambient env (direnv sources .env); this
# script also sources .env directly as a fallback so it works without direnv.
set -euo pipefail
unset CDPATH
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

# ---- pretty output (plain when not a TTY) -----------------------------------
if [ -t 1 ]; then
  b=$'\033[1m'; g=$'\033[32m'; y=$'\033[33m'; c=$'\033[36m'; r=$'\033[31m'; x=$'\033[0m'
else
  b=''; g=''; y=''; c=''; r=''; x=''
fi
step() { printf '\n%s▸ %s%s\n' "$c$b" "$1" "$x"; }
ok()   { printf '  %s✓%s %s\n' "$g" "$x" "$1"; }
warn() { printf '  %s!%s %s\n' "$y" "$x" "$1"; }
die()  { printf '\n%s✗ %s%s\n\n' "$r$b" "$1" "$x" >&2; exit 1; }

# ---- environment ------------------------------------------------------------
step "Environment"
# The apps read ambient env. direnv normally sources .env; source it ourselves as
# a fallback so `pnpm dev` works even without direnv.
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a; . ./.env; set +a
  ok "sourced .env"
fi
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set. Run: cp .env.example .env  (then 'direnv allow' if you use direnv)."
command -v docker >/dev/null 2>&1 || die "docker is not on PATH — start Docker Desktop / colima and retry."
ok "DATABASE_URL set · docker present"

# A full local loop runs with NO paid APIs: default the FAKE seams ON (unless you
# set them) and give the worker the harmless placeholders it wants to boot in
# fake mode. Real values only matter when a FAKE seam is off — set those in .env.
for seam in RESEND_FAKE EXTRACTION_FAKE ANALYSIS_FAKE VISION_FAKE EMBEDDING_FAKE MATCH_FAKE DISCOVERY_FAKE OUTREACH_FAKE; do
  export "$seam=${!seam:-1}"
done
export RESEND_FROM="${RESEND_FROM:-HomeRanger <dev@localhost>}"
export R2_ENDPOINT="${R2_ENDPOINT:-http://localhost:9000}"
export R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-dev}"
export R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-dev}"
export R2_BUCKET_NAME="${R2_BUCKET_NAME:-homeranger-dev}"
ok "fake provider seams on (override any in .env to hit real APIs)"

# ---- infra: postgres + redis (idempotent) -----------------------------------
step "Postgres + Redis"
# 'up -d --wait' only starts/recreates what is missing or unhealthy and waits for
# health — already-healthy containers are left running, not restarted.
docker compose -f docker-compose.dev.yaml up -d --wait
ok "containers healthy"

# ---- prisma client + migrations ---------------------------------------------
step "Prisma client"
pnpm --filter @homeranger/api prisma:generate >/dev/null
ok "generated"

step "Database migrations"
pnpm --filter @homeranger/api prisma:deploy
ok "schema up to date (pending migrations applied)"

# ---- seed (idempotent upsert) -----------------------------------------------
step "Seed data"
pnpm --filter @homeranger/api db:seed
ok "dev fixtures seeded"

# ---- dev servers ------------------------------------------------------------
step "Dev servers — api :${PORT:-3000} · worker · scheduler · web :5173"
printf '  %sstreaming below — press Ctrl-C to stop the whole stack%s\n' "$y" "$x"

# Print a READY banner once the api + web actually answer on localhost. Runs in
# the background (non-fatal if the stack is slow) and is reaped on exit.
(
  for _ in $(seq 1 90); do
    if curl -fsS -o /dev/null "http://localhost:${PORT:-3000}/api/health" 2>/dev/null \
       && curl -fsS -o /dev/null "http://localhost:5173" 2>/dev/null; then
      printf '\n  %s✅ DEV STACK READY%s  →  web %shttp://localhost:5173%s  ·  api %shttp://localhost:%s/api/health%s\n\n' \
        "$g$b" "$x" "$b" "$x" "$b" "${PORT:-3000}" "$x"
      exit 0
    fi
    sleep 2
  done
) &
ready_pid=$!
trap 'kill "$ready_pid" 2>/dev/null || true' EXIT

# Run all four dev servers together. No --kill-others: if one crashes (e.g. the
# worker on a missing optional key) the rest keep serving. Ctrl-C still stops the
# whole group. tsx/vite watchers reload on change.
pnpm exec concurrently \
  --names "api,worker,sched,web" \
  --prefix-colors "blue,magenta,yellow,green" \
  "pnpm dev:api" "pnpm dev:worker" "pnpm dev:scheduler" "pnpm dev:web"
