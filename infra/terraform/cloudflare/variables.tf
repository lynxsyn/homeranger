variable "cloudflare_api_token" {
  description = "Cloudflare API token with zone DNS edit permissions for aid-engineering.com. Injected at apply time from the CLOUDFLARE_API_TOKEN GitHub Actions secret (Bitwarden source: DOXUS_CF_API_TOKEN — the SAME token Doxus uses, same CF account). Not stored in the SOPS tfvars."
  type        = string
  sensitive   = true
}

variable "zone_id" {
  description = "Cloudflare zone ID for the existing aid-engineering.com zone (same CF account as Doxus). Stored in secrets.enc.tfvars."
  type        = string
}

variable "account_id" {
  description = "Cloudflare account ID (same account as Doxus — DOXUS_CF_ACCOUNT_ID). Stored in secrets.enc.tfvars."
  type        = string
}

variable "mail_subdomain" {
  description = "Dedicated Resend sending domain (the apex of the dedicated zone — NOT doxus, NOT a company domain). Single source of truth: every email DNS record FQDN is built from this."
  type        = string
  default     = "aid-engineering.com"
}

variable "app_hostname" {
  description = "Public app hostname served via the Cloudflare Tunnel."
  type        = string
  default     = "app.aid-engineering.com"
}

variable "webhook_hostname" {
  description = "Public hostname for the Resend inbound/event webhooks (M4). Dedicated host that maps to the same homescout-api Service through the tunnel but is NOT behind the Cloudflare Access app — the webhook routes authenticate via Svix signature verification at the API layer. Mirrors Doxus's edge-public api.doxus.app pattern."
  type        = string
  default     = "hooks.aid-engineering.com"
}

variable "tunnel_secret" {
  description = "Secret for Cloudflare Tunnel (base64-encoded, 32+ bytes). Defaults to a generated random_id when empty."
  type        = string
  sensitive   = true
  default     = ""
}
