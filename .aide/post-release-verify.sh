#!/usr/bin/env bash
# homescout post-release verify (AIDE Change Delivery Protocol Step 17).
# SELF-CONTAINED (no doxus-ops dependency).
#
# Two modes (VERIFY_MODE):
#   infra (default, M1): the DB/Redis/Flux gate IS the verify, per
#         docs/specs/M1-infra-scaffold.md DoD. Checks, in order:
#           1. Flux Kustomization `homescout` reconciles to Ready (if registered).
#           2. homescout-postgres + homescout-redis Deployments rolled out.
#           3. Live data checks: SELECT '[1,2,3]'::vector (pgvector) + redis AUTH PING.
#         No app Deployment / HTTP probe (none exists until M2+).
#   app   (M2+): everything in infra PLUS:
#           4. homescout-api Deployment rolled out.
#           5. HTTP /api/health == 200 and /api/version contains MERGE_SHA.
#
# Env: MERGE_SHA (required, used in app mode for the version-ancestry check).
#      VERIFY_MODE=infra|app  NS=homescout  FLUX_NS=flux-system  KS=homescout
#      KUBE_CONTEXT (optional)  VERIFY_TIMEOUT_SEC=600
#      VERIFY_API_BASE_URL (app mode external probe; else in-cluster curl)
set -euo pipefail

: "${MERGE_SHA:?MERGE_SHA is required}"
VERIFY_MODE="${VERIFY_MODE:-infra}"
NS="${NS:-homescout}"
FLUX_NS="${FLUX_NS:-flux-system}"
KS="${KS:-homescout}"
TIMEOUT="${VERIFY_TIMEOUT_SEC:-600}"
KCTX=(${KUBE_CONTEXT:+--context "$KUBE_CONTEXT"})
K() { kubectl "${KCTX[@]}" "$@"; }
log() { printf '[verify] %s\n' "$*"; }
fail() { printf '[verify][FAIL] %s\n' "$*" >&2; exit 1; }

# 1. Flux Kustomization Ready (skip gracefully if the source isn't registered yet,
#    e.g. the pre-merge imperative bootstrap before main carries infra/deploy).
if K -n "$FLUX_NS" get kustomization "$KS" >/dev/null 2>&1; then
  log "reconciling Flux Kustomization/$KS …"
  flux reconcile kustomization "$KS" -n "$FLUX_NS" --with-source 2>/dev/null || true
  deadline=$(( $(date +%s) + TIMEOUT ))
  until [ "$(K -n "$FLUX_NS" get kustomization "$KS" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = "True" ]; do
    [ "$(date +%s)" -ge "$deadline" ] && fail "Flux Kustomization/$KS not Ready within ${TIMEOUT}s"
    sleep 5
  done
  log "Flux Kustomization/$KS Ready ✓ (rev $(K -n "$FLUX_NS" get kustomization "$KS" -o jsonpath='{.status.lastAppliedRevision}' 2>/dev/null))"
else
  log "Flux Kustomization/$KS not registered yet — skipping Flux gate (pre-merge bootstrap)"
fi

# 2. Data-layer rollouts.
log "waiting for postgres + redis rollouts …"
K -n "$NS" rollout status deploy/homescout-postgres --timeout="${TIMEOUT}s" || fail "homescout-postgres not rolled out"
K -n "$NS" rollout status deploy/homescout-redis --timeout="${TIMEOUT}s" || fail "homescout-redis not rolled out"

# 3. Live data checks (encode the gate the operator ran manually at bootstrap).
log "pgvector check: SELECT '[1,2,3]'::vector …"
K -n "$NS" exec deploy/homescout-postgres -- psql -U homescout_admin -d homescout -tAc "SELECT '[1,2,3]'::vector;" >/dev/null \
  || fail "pgvector SELECT failed (extension missing?)"
log "redis AUTH PING …"
RPW="$(K -n "$NS" get secret homescout-secret -o jsonpath='{.data.REDIS_PASSWORD}' | base64 -d)"
[ "$(K -n "$NS" exec deploy/homescout-redis -- env REDISCLI_AUTH="$RPW" redis-cli ping 2>/dev/null)" = "PONG" ] \
  || fail "redis PING did not return PONG"
log "infra gate PASSED ✓ (pgvector + roles via init-Job, redis reachable)"

if [ "$VERIFY_MODE" != "app" ]; then
  log "VERIFY_MODE=infra — done."
  exit 0
fi

# 4. App deployment (M2+).
log "VERIFY_MODE=app — waiting for homescout-api rollout …"
K -n "$NS" rollout status deploy/homescout-api --timeout="${TIMEOUT}s" || fail "homescout-api not rolled out"

# 5. HTTP /api/health + /api/version SHA-ancestry.
probe() { # $1=path -> echoes body, returns curl exit
  if [ -n "${VERIFY_API_BASE_URL:-}" ]; then
    curl -fsS ${CF_ACCESS_CLIENT_ID:+-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID"} \
         ${CF_ACCESS_CLIENT_SECRET:+-H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"} \
         "${VERIFY_API_BASE_URL%/}$1"
  else
    K -n "$NS" exec deploy/homescout-api -- sh -c "curl -fsS http://localhost:3000$1"
  fi
}
log "GET /api/health …"; probe /api/health >/dev/null || fail "/api/health not healthy"
log "GET /api/version (expect MERGE_SHA $MERGE_SHA) …"
VER="$(probe /api/version || true)"
printf '%s' "$VER" | grep -q "$MERGE_SHA" || fail "/api/version did not contain merge SHA $MERGE_SHA (got: $VER)"
log "app gate PASSED ✓ (/api/health + /api/version matches $MERGE_SHA)"
