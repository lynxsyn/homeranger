#!/usr/bin/env bash
# synced-from: aide@f0452f88a2b90cb654b431ae75da3e026fc6ad43
# drift-check: scripts/check-aide-drift.sh
#
# homeranger post-release verify (AIDE Change Delivery Protocol Step 17).
# SELF-CONTAINED (no ops-repo dependency at runtime).
#
# Structure: sources .aide/project.env for defaults, then runs the core
# generic gates (Flux + deployment rollout + HTTP probes), then appends
# homeranger-specific extras (data-layer rollouts + pgvector + Redis PING
# + tRPC routing gate). The homeranger extras are ADDITIONAL to the core
# gates, not replacements — they were the source the core's two-mode
# framework was modeled on.
#
# ── Mode summary ─────────────────────────────────────────────────────────────
# VERIFY_MODE=infra (default)
#   Core:         Flux Kustomization reconcile wait.
#   HR extras:    homeranger-postgres + homeranger-redis rollout +
#                 pgvector SELECT + Redis AUTH PING.
#
# VERIFY_MODE=app (M2+)
#   Core:         infra checks PLUS homeranger-api rollout +
#                 HTTP /api/health (200) + /api/version contains MERGE_SHA.
#   HR extras:    all infra extras PLUS /trpc/health routing gate through
#                 the public edge (guards Cloudflare Tunnel /trpc routing).
#
# Not-provisioned stub:
#   VERIFY_TARGET_PROVISIONED=false → exit 3 with message.
#   Use when the environment is wired but not yet deployed.
#
# ── Env contract ─────────────────────────────────────────────────────────────
# From .aide/project.env (all overridable by env):
#   AIDE_PROJECT            — project slug (homeranger)
#   VERIFY_MODE             — infra | app  (default: app — homeranger is M2+)
#   VERIFY_NAMESPACE        — Kubernetes namespace (default: homeranger)
#   VERIFY_DEPLOYMENT       — app-mode deployment name (default: homeranger-api)
#   VERIFY_API_BASE_URL     — external base URL for HTTP probes (app mode)
#   VERIFY_FLUX_KS          — Flux Kustomization name (default: homeranger)
#   VERIFY_FLUX_NS          — Flux namespace (default: flux-system)
#   VERIFY_TIMEOUT_SEC      — seconds to wait per gate (default: 600)
#   VERIFY_TARGET_PROVISIONED — false → exit 3 (default: true)
#
# Additional (not in project.env; pass on command line):
#   MERGE_SHA               — required; squash-merge SHA
#   KUBE_CONTEXT            — optional kubectl context override
#   CF_ACCESS_CLIENT_ID     — optional Cloudflare Access service token
#   CF_ACCESS_CLIENT_SECRET — optional Cloudflare Access service token
#
# ── Exit codes ───────────────────────────────────────────────────────────────
#   0  — all required gates passed
#   1  — a gate failed (see [verify][FAIL] lines on stderr)
#   3  — VERIFY_TARGET_PROVISIONED=false (not provisioned stub)

set -euo pipefail

# ── 0. Load project defaults (env-var already set takes precedence) ───────────
# Source project.env as defaults only — do NOT overwrite variables the caller
# already has in the environment. This preserves VERIFY_TARGET_PROVISIONED=false
# (and other overrides) when passed on the command line.
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$_SCRIPT_DIR/project.env" ]]; then
  while IFS= read -r _line || [[ -n "$_line" ]]; do
    # Skip comments and blank lines.
    [[ "$_line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${_line// }" ]] && continue
    # Only set if the variable is not already in the environment.
    _var="${_line%%=*}"
    if [[ -n "$_var" ]] && [[ "${_var}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      if [[ -z "${!_var+x}" ]]; then
        # shellcheck disable=SC2163
        export "$_line"
      fi
    fi
  done < "$_SCRIPT_DIR/project.env"
fi

: "${MERGE_SHA:?MERGE_SHA is required}"

# Not-provisioned stub — explicit, non-zero, never a fake pass.
if [[ "${VERIFY_TARGET_PROVISIONED:-true}" == "false" ]]; then
  printf '[verify] target not provisioned (VERIFY_TARGET_PROVISIONED=false) — skipping verify\n' >&2
  exit 3
fi

VERIFY_MODE="${VERIFY_MODE:-infra}"
VERIFY_FLUX_NS="${VERIFY_FLUX_NS:-flux-system}"
VERIFY_HEALTH_PATH="${VERIFY_HEALTH_PATH:-/health}"
VERIFY_VERSION_PATH="${VERIFY_VERSION_PATH:-/version}"
TIMEOUT="${VERIFY_TIMEOUT_SEC:-600}"
KCTX=(${KUBE_CONTEXT:+--context "$KUBE_CONTEXT"})

K() { kubectl "${KCTX[@]}" "$@"; }
log()  { printf '[verify] %s\n' "$*"; }
fail() { printf '[verify][FAIL] %s\n' "$*" >&2; exit 1; }

# Validate VERIFY_MODE.
case "$VERIFY_MODE" in
  infra|app) ;;
  *) fail "VERIFY_MODE must be 'infra' or 'app' (got: $VERIFY_MODE)" ;;
esac

# ── 1. Flux Kustomization ready (skip gracefully when not registered) ──
if [[ -n "${VERIFY_FLUX_KS:-}" ]]; then
  if K -n "$VERIFY_FLUX_NS" get kustomization "$VERIFY_FLUX_KS" >/dev/null 2>&1; then
    log "reconciling Flux Kustomization/$VERIFY_FLUX_KS …"
    flux reconcile kustomization "$VERIFY_FLUX_KS" -n "$VERIFY_FLUX_NS" \
      --with-source 2>/dev/null || true
    deadline=$(( $(date +%s) + TIMEOUT ))
    until [ "$(K -n "$VERIFY_FLUX_NS" get kustomization "$VERIFY_FLUX_KS" \
               -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' \
               2>/dev/null)" = "True" ]; do
      [ "$(date +%s)" -ge "$deadline" ] && \
        fail "Flux Kustomization/$VERIFY_FLUX_KS not Ready within ${TIMEOUT}s"
      sleep 5
    done
    log "Flux Kustomization/$VERIFY_FLUX_KS Ready (rev $(K -n "$VERIFY_FLUX_NS" get kustomization \
      "$VERIFY_FLUX_KS" -o jsonpath='{.status.lastAppliedRevision}' 2>/dev/null))"
  else
    log "Flux Kustomization/$VERIFY_FLUX_KS not registered — skipping Flux gate"
  fi
else
  log "VERIFY_FLUX_KS not set — skipping Flux gate"
fi

# ── 2. Data-layer rollouts (homeranger-specific) ──────────────────────────────
# Postgres and Redis are stateful Deployments that precede the API — check them
# in both modes (infra + app) so M1 verify proves the data layer is healthy.
log "waiting for homeranger-postgres + homeranger-redis rollouts …"
K -n "$VERIFY_NAMESPACE" rollout status deploy/homeranger-postgres \
  --timeout="${TIMEOUT}s" || fail "homeranger-postgres not rolled out"
K -n "$VERIFY_NAMESPACE" rollout status deploy/homeranger-redis \
  --timeout="${TIMEOUT}s" || fail "homeranger-redis not rolled out"

# ── 3. Live data checks (homeranger-specific) ─────────────────────────────────
# pgvector: encodes the gate the operator ran manually at bootstrap.
log "pgvector check: SELECT '[1,2,3]'::vector …"
K -n "$VERIFY_NAMESPACE" exec deploy/homeranger-postgres -- \
  psql -U homeranger_admin -d homeranger -tAc "SELECT '[1,2,3]'::vector;" >/dev/null \
  || fail "pgvector SELECT failed (extension missing?)"

# Redis AUTH PING — extract password from the cluster secret.
log "redis AUTH PING …"
RPW="$(K -n "$VERIFY_NAMESPACE" get secret homeranger-secret \
  -o jsonpath='{.data.REDIS_PASSWORD}' | base64 -d)"
[ "$(K -n "$VERIFY_NAMESPACE" exec deploy/homeranger-redis -- \
  env REDISCLI_AUTH="$RPW" redis-cli ping 2>/dev/null)" = "PONG" ] \
  || fail "redis PING did not return PONG"
log "infra gate PASSED (pgvector + redis reachable)"

if [[ "$VERIFY_MODE" == "infra" ]]; then
  log "VERIFY_MODE=infra — done."
  exit 0
fi

# ── 4. App deployment rollout (core gate) ─────────────────────────────────────
log "VERIFY_MODE=app — waiting for $VERIFY_DEPLOYMENT rollout …"
K -n "$VERIFY_NAMESPACE" rollout status \
  "deploy/$VERIFY_DEPLOYMENT" --timeout="${TIMEOUT}s" \
  || fail "$VERIFY_DEPLOYMENT not rolled out"

# ── 5. HTTP probes (core gate, parameterized) ─────────────────────────────────
probe() {  # $1=path -> echoes body
  local path="$1"
  if [[ -n "${VERIFY_API_BASE_URL:-}" ]]; then
    curl -fsS \
      ${CF_ACCESS_CLIENT_ID:+-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID"} \
      ${CF_ACCESS_CLIENT_SECRET:+-H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"} \
      "${VERIFY_API_BASE_URL%/}${path}"
  else
    # In-cluster: homeranger-api runs node:alpine (wget, no curl).
    # Use 127.0.0.1 — alpine resolves localhost to ::1 (IPv6) while
    # Fastify listens on IPv4 0.0.0.0.
    K -n "$VERIFY_NAMESPACE" exec \
      "deploy/$VERIFY_DEPLOYMENT" -c api -- \
      wget -qO- "http://127.0.0.1:${VERIFY_CONTAINER_PORT:-3000}${path}"
  fi
}

log "GET ${VERIFY_HEALTH_PATH} …"
probe "$VERIFY_HEALTH_PATH" >/dev/null \
  || fail "${VERIFY_HEALTH_PATH} did not return 200"

log "GET ${VERIFY_VERSION_PATH} (expect MERGE_SHA $MERGE_SHA) …"
VER="$(probe "$VERIFY_VERSION_PATH" || true)"
printf '%s' "$VER" | grep -q "$MERGE_SHA" \
  || fail "${VERIFY_VERSION_PATH} did not contain merge SHA $MERGE_SHA (got: $VER)"
log "app gate PASSED (${VERIFY_HEALTH_PATH} + ${VERIFY_VERSION_PATH} matches $MERGE_SHA)"

# ── 6. tRPC routing gate (homeranger-specific, external probe only) ───────────
# The SPA's entire data plane posts to /trpc, which the API mounts at /trpc —
# NOT under /api (only /api/health + /api/version live there). A Cloudflare
# Tunnel ingress that routes only /api + /ws to the API will serve the nginx
# SPA shell (text/html) for /trpc instead of JSON, silently breaking the whole
# app — and /api/health (a raw route the tunnel DOES route) cannot catch it.
# health is a tRPC publicProcedure returning 200 JSON even past CF Access.
# The in-cluster probe path skips this (it bypasses the tunnel).
if [[ -n "${VERIFY_API_BASE_URL:-}" ]]; then
  log "GET /trpc/health (expect API JSON through the tunnel, not the nginx SPA shell) …"
  TRPC_BODY="$(probe /trpc/health || true)"
  case "$TRPC_BODY" in
    *'<!DOCTYPE'* | *'<!doctype'* | *'<html'*)
      fail "/trpc returned the HTML SPA shell — the tunnel is not routing /trpc to the API (add a /trpc ingress rule in infra/terraform/cloudflare/tunnel.tf)" ;;
  esac
  printf '%s' "$TRPC_BODY" | grep -q '"result"' \
    || fail "/trpc/health did not return a tRPC JSON result (got: $(printf '%s' "$TRPC_BODY" | head -c 200))"
  log "tRPC routing gate PASSED (/trpc reaches the API as JSON through the edge)"
fi
