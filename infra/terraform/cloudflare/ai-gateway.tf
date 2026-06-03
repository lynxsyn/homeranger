# ── Cloudflare AI Gateway (transparent proxy for outbound LLM calls) ──
# A single gateway fronts homeranger's Anthropic traffic (M4 Claude extraction;
# Voyage + Haiku join in M5) for token/cost analytics, response caching, retries
# and a queryable request log — WITHOUT changing the model, the prompt, or the
# call sites. The app keeps its own ANTHROPIC_API_KEY and only points the SDK
# baseURL at:
#   https://gateway.ai.cloudflare.com/v1/<account_id>/<var.ai_gateway_id>/anthropic
#
# Activation is env-driven in the app (CF_AI_GATEWAY_ACCOUNT_ID / CF_AI_GATEWAY_ID,
# optional CF_AI_GATEWAY_TOKEN). Unset env = direct-to-provider, so this resource
# applies INDEPENDENTLY of wiring the app env — no chicken-and-egg ordering. See
# docs/decisions/2026-06-02-ai-gateway.md + packages/backend-core/src/lib/ai/ai-gateway.ts.
#
# cloudflare_ai_gateway is supported by the pinned provider (cloudflare 5.19.1).
# Schema-required: id, collect_logs, cache_ttl, cache_invalidate_on_update,
# rate_limiting_interval, rate_limiting_limit.
resource "cloudflare_ai_gateway" "homeranger" {
  account_id = var.account_id
  id         = var.ai_gateway_id

  # Logging is the primary value here (request log + token/cost analytics). For a
  # zero-data-retention posture (residency-tighten), set zdr=true upstream and
  # collect_logs=false — at the cost of the analytics this adoption exists for.
  collect_logs = true

  # Logpush OFF — set explicitly to false rather than left unset. The
  # cloudflare provider v5.19.1 serialises an unset `logpush` as JSON null on the
  # UPDATE (PUT) call, and the AI Gateway API rejects that with
  # `7001: Expected boolean, received null`, so every in-place apply errors with
  # an opaque "failed to make http request". A concrete boolean makes update
  # idempotent. (We rely on collect_logs for analytics, not Logpush export.)
  logpush = false

  # Caching OFF by default: estate-agent emails rarely repeat byte-for-byte, so a
  # cache mostly adds surprise (a retried extraction returning a stale result).
  # cache_ttl = 0 disables it; raise var.ai_gateway_cache_ttl if ever wanted.
  cache_ttl                  = var.ai_gateway_cache_ttl
  cache_invalidate_on_update = false

  # Rate limiting OFF (interval = limit = 0): a single-user tool needs no
  # gateway-side throttle, and the BullMQ worker concurrency already bounds spend.
  rate_limiting_interval = 0
  rate_limiting_limit    = 0

  # Log-retention fields declared to MATCH the Cloudflare defaults the gateway is
  # created with, so `tofu plan` converges. Left unset, provider v5.19.1
  # serialises them as JSON null on UPDATE, the API keeps its defaults, and every
  # apply re-shows an in-place "drift" that never converges. Pinning them = stable
  # plans. Logs are kept (collect_logs=true, zdr=false — the analytics this exists
  # for); the gateway retains up to log_management entries, oldest deleted first.
  zdr                     = false
  log_management          = 100000
  log_management_strategy = "DELETE_OLDEST"

  # Unauthenticated by default. The gateway URL embeds the account id but stores
  # NO provider key (the app sends its own ANTHROPIC_API_KEY), so the only
  # exposure is log/quota pollution by someone who learns the URL — acceptable
  # for a single-user tool. Flip authentication=true + set CF_AI_GATEWAY_TOKEN
  # (a CF API token with "AI Gateway Run") to require the cf-aig-authorization
  # bearer; the app adds that header automatically when the token env is present.
  authentication = var.ai_gateway_authentication
}

output "ai_gateway_id" {
  value       = cloudflare_ai_gateway.homeranger.id
  description = "AI Gateway slug — set as CF_AI_GATEWAY_ID in the homeranger secret (paired with CF_AI_GATEWAY_ACCOUNT_ID = the Cloudflare account id)."
}
