output "zone_id" {
  value       = var.zone_id
  description = "homeranger.app zone ID (existing zone, passed through from tfvars)"
}

output "tunnel_id" {
  value       = cloudflare_zero_trust_tunnel_cloudflared.homeranger.id
  description = "Cloudflare Tunnel ID for app.homeranger.app"
}

# Retrieve the tunnel connector token via:
#   cf api /accounts/{account_id}/cfd_tunnel/{tunnel_id}/token
# (tunnel_token is not a computed attribute in cloudflare provider v5.)
