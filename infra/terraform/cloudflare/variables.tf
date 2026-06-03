variable "cloudflare_api_token" {
  description = "Cloudflare API token for the homeranger edge. Needs (account) AI Gateway:Edit, Workers R2:Edit, Cloudflare Tunnel:Edit, Access Apps/Policies + Service Tokens:Edit; (zone, homeranger.app) DNS:Edit, Zone WAF:Edit, Access Apps/Policies:Edit, Zone:Read. Sourced from the dedicated HOMERANGER_CF_API_TOKEN (.env locally / GitHub Actions secret CLOUDFLARE_API_TOKEN in CI) — a homeranger-scoped token, NOT the shared Doxus token, so its blast radius is isolated. Injected at apply time as TF_VAR_cloudflare_api_token; never stored in the SOPS tfvars."
  type        = string
  sensitive   = true
}

variable "zone_id" {
  description = "Cloudflare zone ID for the existing homeranger.app zone (same CF account as Doxus). Stored in secrets.enc.tfvars."
  type        = string
}

variable "account_id" {
  description = "Cloudflare account ID (same account as Doxus — DOXUS_CF_ACCOUNT_ID). Stored in secrets.enc.tfvars."
  type        = string
}

variable "mail_subdomain" {
  description = "Dedicated Resend sending domain (the apex of the dedicated zone — NOT doxus, NOT a company domain). Single source of truth: every email DNS record FQDN is built from this."
  type        = string
  default     = "homeranger.app"
}

variable "app_hostname" {
  description = "Public app hostname served via the Cloudflare Tunnel."
  type        = string
  default     = "homeranger.app"
}

variable "tunnel_secret" {
  description = "Secret for Cloudflare Tunnel (base64-encoded, 32+ bytes). Defaults to a generated random_id when empty."
  type        = string
  sensitive   = true
  default     = ""
}

variable "ai_gateway_id" {
  description = "Cloudflare AI Gateway slug fronting homeranger's outbound LLM calls (M4 Claude extraction; M5 Voyage/Haiku). Set as CF_AI_GATEWAY_ID in the homeranger secret."
  type        = string
  default     = "homeranger"
}

variable "ai_gateway_authentication" {
  description = "Require the cf-aig-authorization bearer on the AI Gateway. When true, also set CF_AI_GATEWAY_TOKEN (a CF API token with 'AI Gateway Run') in the homeranger secret."
  type        = bool
  default     = false
}

variable "ai_gateway_cache_ttl" {
  description = "AI Gateway response cache TTL in seconds. 0 disables caching (the default — agent emails rarely repeat byte-for-byte)."
  type        = number
  default     = 0
}
