# ── Cloudflare Zero Trust Access for the homescout app ──
# A self-hosted Access application fronting app.aid-engineering.com (the same
# hostname the tunnel serves). Cloudflare challenges the request, mints a JWT,
# and stamps it as the `Cf-Access-Jwt-Assertion` header on every proxied
# request — which the api verifies in-process (jose) against the team JWKS,
# asserting iss/aud and `email == ALLOWED_USER_EMAIL`.
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
  name       = "homescout-post-release-verify"
}

# Human (browser) access: the owner authenticates interactively via the team
# IdP / one-time PIN and the verified `email` claim must equal var.owner_email.
resource "cloudflare_zero_trust_access_policy" "homescout_owner_allow" {
  account_id = var.account_id
  name       = "Allow owner — homescout"
  decision   = "allow"
  include = [
    {
      email = {
        email = var.owner_email
      }
    },
  ]
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
resource "cloudflare_zero_trust_access_policy" "homescout_service_auth" {
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

resource "cloudflare_zero_trust_access_application" "homescout" {
  zone_id          = var.zone_id
  name             = "homescout"
  domain           = var.app_hostname
  session_duration = "24h"
  type             = "self_hosted"
  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.homescout_owner_allow.id
      precedence = 1
    },
    {
      id         = cloudflare_zero_trust_access_policy.homescout_service_auth.id
      precedence = 2
    },
  ]
}
