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
  policies = [{
    id         = cloudflare_zero_trust_access_policy.homescout_owner_allow.id
    precedence = 1
  }]
}
