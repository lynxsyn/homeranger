# ── Cloudflare Zero Trust Access for the homeranger app ──
# A self-hosted Access application fronting homeranger.app (the same hostname the
# tunnel serves). It is now the EDGE ALLOWLIST: Cloudflare challenges the request
# and only the allowed emails (var.owner_email + var.second_user_email) get
# through to the app. In-app authentication is SUPABASE (the SPA signs in and the
# api verifies the Supabase JWT) — so the app is double-gated (CF Access at the
# edge, Supabase in-app). The api no longer verifies the CF Access JWT; CF Access
# just decides WHO reaches the app, keeping it off the public internet.
#
# cloudflare/cloudflare v5 resource names (pinned 5.19.1 in versions.tf):
#   - application = cloudflare_zero_trust_access_application
#   - policy      = cloudflare_zero_trust_access_policy
#   - svc token   = cloudflare_zero_trust_access_service_token
# In v5 a policy `include` is a list of typed objects ({ email = { email = … }},
# { service_token = { token_id = … }}) and the application attaches policies via
# `policies = [{ id = …, precedence = 1 }]`. The app's `aud` is computed (output
# it for the api's CF_ACCESS_AUD).

resource "cloudflare_zero_trust_access_service_token" "post_release_verify" {
  account_id = var.account_id
  name       = "homeranger-post-release-verify"
}

# Human (browser) access: the allowed users authenticate interactively via the
# team IdP / one-time PIN; only these emails pass the edge (then sign in with
# Supabase in-app). Add more users by extending this allowlist. An empty
# second_user_email collapses to just the owner.
resource "cloudflare_zero_trust_access_policy" "homeranger_owner_allow" {
  account_id = var.account_id
  name       = "Allow users — homeranger"
  decision   = "allow"
  include = concat(
    [{ email = { email = var.owner_email } }],
    var.second_user_email != "" ? [{ email = { email = var.second_user_email } }] : [],
  )
}

# Headless (service-token) access for post-release-verify probes. A service
# token MUST live in a `non_identity` ("Service Auth") policy — in a plain
# `allow` (identity) policy CF Access still runs the interactive login flow and
# the token alone yields service_token_status=false (302 to the login page).
# This dedicated non_identity policy is what makes the CF-Access-Client-Id /
# CF-Access-Client-Secret headers authenticate non-interactively. The api still
# independently verifies the CF Access JWT; a service-token JWT carries
# `common_name`, not `email`, so the api's email-gated (protected) procedures
# stay denied — only public routes/probes pass, which is what the verify gate
# needs (it probes the `health` publicProcedure).
resource "cloudflare_zero_trust_access_policy" "homeranger_service_auth" {
  account_id = var.account_id
  name       = "Service Auth — post-release-verify"
  decision   = "non_identity"
  include = [
    {
      service_token = {
        token_id = cloudflare_zero_trust_access_service_token.post_release_verify.id
      }
    },
  ]
}

resource "cloudflare_zero_trust_access_application" "homeranger" {
  zone_id          = var.zone_id
  name             = "homeranger"
  domain           = var.app_hostname
  session_duration = "24h"
  type             = "self_hosted"
  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.homeranger_owner_allow.id
      precedence = 1
    },
    {
      id         = cloudflare_zero_trust_access_policy.homeranger_service_auth.id
      precedence = 2
    },
  ]
}

# ── Public machine endpoints (Access BYPASS) ──
# A couple of endpoints can't pass the human login wall: the RFC-8058 one-click
# unsubscribe (mail clients click it) and the Resend webhooks (Resend POSTs to
# them). They live on the SAME homeranger.app host, but as path-scoped Access
# apps with a `bypass` decision so Cloudflare lets them through unauthenticated.
# A more-specific path app takes precedence over the catch-all `homeranger` app
# above, so EVERYTHING ELSE on homeranger.app stays behind the login wall. These
# endpoints are NOT unprotected — each verifies its own crypto in-process: the
# unsubscribe link carries an HMAC token; the webhook routes verify the Svix
# signature on the raw body before doing anything.
#
# GUARDRAIL — the bypass domain is a PREFIX. "homeranger.app/webhooks" matches
# /webhooks AND everything beneath it (/webhooks/*); likewise the unsubscribe
# path. So ANY future route mounted under these prefixes inherits the edge
# bypass and is reachable UNAUTHENTICATED — it MUST carry its own in-process
# verification (Svix / HMAC / equivalent) before any side effect, or it becomes
# a public side-effecting endpoint. Keep all authenticated business logic on the
# /trpc data plane (behind the catch-all app), never under these bypass prefixes.
resource "cloudflare_zero_trust_access_policy" "public_bypass" {
  account_id = var.account_id
  name       = "Public bypass — homeranger machine endpoints"
  decision   = "bypass"
  include    = [{ everyone = {} }]
}

resource "cloudflare_zero_trust_access_application" "unsubscribe" {
  zone_id          = var.zone_id
  name             = "homeranger unsubscribe (public)"
  domain           = "${var.app_hostname}/api/outreach/unsubscribe"
  session_duration = "24h"
  type             = "self_hosted"
  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.public_bypass.id
      precedence = 1
    },
  ]
}

resource "cloudflare_zero_trust_access_application" "webhooks" {
  zone_id          = var.zone_id
  name             = "homeranger webhooks (public)"
  domain           = "${var.app_hostname}/webhooks"
  session_duration = "24h"
  type             = "self_hosted"
  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.public_bypass.id
      precedence = 1
    },
  ]
}
