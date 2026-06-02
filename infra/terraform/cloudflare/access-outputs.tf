# Cloudflare Access outputs (separate file for a clean reviewable diff).

output "app_access_aud" {
  value       = cloudflare_zero_trust_access_application.homescout.aud
  description = "The Access application AUD tag — set as the api's CF_ACCESS_AUD secret so jose validates the JWT audience."
}

output "post_release_verify_client_id" {
  value       = cloudflare_zero_trust_access_service_token.post_release_verify.client_id
  description = "Service-token client ID for post-release-verify probes against the gated app host (non-secret)."
}

output "post_release_verify_client_secret" {
  value       = cloudflare_zero_trust_access_service_token.post_release_verify.client_secret
  description = "Service-token client secret for post-release-verify (captured at apply time; store in GH Actions secrets / .env)."
  sensitive   = true
}
