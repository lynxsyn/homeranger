#!/usr/bin/env bash
# homeranger post-release verify (AIDE Change Delivery Protocol Step 17).
# SELF-CONTAINED (no doxus-ops dependency).
#
# Two modes (VERIFY_MODE):
#   infra (default, M1): the DB/Redis/Flux gate IS the verify, per
#         docs/specs/M1-infra-scaffold.md DoD. Checks, in order:
#           1. Flux Kustomization `homeranger` reconciles to Ready (if registered).
#           2. homeranger-postgres + homeranger-redis Deployments rolled out.
#           3. Live data checks: SELECT '[1,2,3]'::vector (pgvector) + redis AUTH PING.
#         No app Deployment / HTTP probe (none exists until M2+).
#   app   (M2+): everything in infra PLUS:
#           4. homeranger-api Deployment rolled out.
#           5. HTTP /api/health == 200 and /api/version contains MERGE_SHA.
#           6. (external probe only) /trpc reaches the API as JSON, not the
#              nginx SPA shell — guards the tunnel-ingress /trpc routing.
#
# Env: MERGE_SHA (required, used in app mode for the version-ancestry check).
#      VERIFY_MODE=infra|app  NS=homeranger  FLUX_NS=flux-system  KS=homeranger
#      KUBE_CONTEXT (optional)  VERIFY_TIMEOUT_SEC=600
#      VERIFY_API_BASE_URL (app mode external probe; else in-cluster curl)
set -euo pipefail

: "${MERGE_SHA:?MERGE_SHA is required}"
VERIFY_MODE="${VERIFY_MODE:-infra}"
NS="${NS:-homeranger}"
FLUX_NS="${FLUX_NS:-flux-system}"
KS="${KS:-homeranger}"
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
K -n "$NS" rollout status deploy/homeranger-postgres --timeout="${TIMEOUT}s" || fail "homeranger-postgres not rolled out"
K -n "$NS" rollout status deploy/homeranger-redis --timeout="${TIMEOUT}s" || fail "homeranger-redis not rolled out"

# 3. Live data checks (encode the gate the operator ran manually at bootstrap).
log "pgvector check: SELECT '[1,2,3]'::vector …"
K -n "$NS" exec deploy/homeranger-postgres -- psql -U homeranger_admin -d homeranger -tAc "SELECT '[1,2,3]'::vector;" >/dev/null \
  || fail "pgvector SELECT failed (extension missing?)"
log "redis AUTH PING …"
RPW="$(K -n "$NS" get secret homeranger-secret -o jsonpath='{.data.REDIS_PASSWORD}' | base64 -d)"
[ "$(K -n "$NS" exec deploy/homeranger-redis -- env REDISCLI_AUTH="$RPW" redis-cli ping 2>/dev/null)" = "PONG" ] \
  || fail "redis PING did not return PONG"
log "infra gate PASSED ✓ (pgvector + roles via init-Job, redis reachable)"

if [ "$VERIFY_MODE" != "app" ]; then
  log "VERIFY_MODE=infra — done."
  exit 0
fi

# 4. App deployment (M2+).
log "VERIFY_MODE=app — waiting for homeranger-api rollout …"
K -n "$NS" rollout status deploy/homeranger-api --timeout="${TIMEOUT}s" || fail "homeranger-api not rolled out"

# 5. HTTP /api/health + /api/version SHA-ancestry.
probe() { # $1=path -> echoes body
  if [ -n "${VERIFY_API_BASE_URL:-}" ]; then
    curl -fsS ${CF_ACCESS_CLIENT_ID:+-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID"} \
         ${CF_ACCESS_CLIENT_SECRET:+-H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"} \
         "${VERIFY_API_BASE_URL%/}$1"
  else
    # In-cluster: the api runtime is node:alpine (busybox wget, no curl); use
    # 127.0.0.1 (not localhost — alpine resolves localhost to ::1 (IPv6) while
    # Fastify listens on IPv4 0.0.0.0).
    K -n "$NS" exec deploy/homeranger-api -c api -- wget -qO- "http://127.0.0.1:3000$1"
  fi
}
log "GET /api/health …"; probe /api/health >/dev/null || fail "/api/health not healthy"
log "GET /api/version (expect MERGE_SHA $MERGE_SHA) …"
VER="$(probe /api/version || true)"
printf '%s' "$VER" | grep -q "$MERGE_SHA" || fail "/api/version did not contain merge SHA $MERGE_SHA (got: $VER)"
log "app gate PASSED ✓ (/api/health + /api/version matches $MERGE_SHA)"

# 6. External tRPC routing gate (ONLY when probing through the public edge).
#    The SPA's entire data plane posts to /trpc, which the API mounts at prefix
#    /trpc — NOT under /api (only /api/health + /api/version live there). A
#    Cloudflare-Tunnel ingress that routes only /api + /ws to the API serves the
#    nginx SPA shell (text/html) for /trpc instead of JSON, silently breaking the
#    whole app — and /api/health (a raw route the tunnel DOES route) cannot catch
#    it. So when VERIFY_API_BASE_URL points at the public host, assert /trpc
#    reaches the API (JSON) rather than nginx (HTML). `health` is a tRPC
#    publicProcedure, so it returns 200 JSON even past CF Access without matching
#    ALLOWED_USER_EMAIL. The in-cluster probe path skips this (it bypasses the
#    tunnel, so it can't observe the ingress routing).
if [ -n "${VERIFY_API_BASE_URL:-}" ]; then
  log "GET /trpc/health (expect API JSON through the tunnel, not the nginx SPA shell) …"
  TRPC_BODY="$(probe /trpc/health || true)"
  case "$TRPC_BODY" in
    *'<!DOCTYPE'* | *'<!doctype'* | *'<html'*)
      fail "/trpc returned the HTML SPA shell — the tunnel is not routing /trpc to the API (add a /trpc ingress rule in infra/terraform/cloudflare/tunnel.tf)" ;;
  esac
  printf '%s' "$TRPC_BODY" | grep -q '"result"' \
    || fail "/trpc/health did not return a tRPC JSON result (got: $(printf '%s' "$TRPC_BODY" | head -c 200))"
  log "tRPC routing gate PASSED ✓ (/trpc reaches the API as JSON through the edge)"
fi
