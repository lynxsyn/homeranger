# ── Custom WAF (M4) ──
# Mirrors doxus-infra/terraform/cloudflare/waf.tf, scoped to homescout's two
# public hostnames (app + webhook). Two load-bearing rules for M4:
#
#   1. Origin-IP / unknown-host block — any request whose Host is NOT one of
#      homescout's published hostnames is dropped at the edge, so the tunnel
#      origin is never reachable by raw IP or a spoofed Host. The Resend
#      webhook host (var.webhook_hostname) is in the allowlist so inbound
#      webhooks pass through to the api.
#   2. /metrics block — the api (and processor, in-cluster) expose Prometheus
#      metrics; the public edge must never serve them (leaks queue depths,
#      route names, error counts). In-cluster scrapes hit the Service directly
#      and never traverse Cloudflare, so this only affects public traffic.
#
# NOTE: this ruleset runs on the SHARED aid-engineering.com zone. If a future
# tenant / sibling app adds its own hostnames on this zone, append them to the
# allowlist expression (rule 1) or it will block them. Keep this in sync with
# the tunnel ingress `hostname` blocks in tunnel.tf.
resource "cloudflare_ruleset" "custom_waf" {
  zone_id = var.zone_id
  name    = "homescout Custom WAF Rules"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  rules = [
    {
      expression  = "(http.host ne \"${var.app_hostname}\") and (http.host ne \"${var.webhook_hostname}\")"
      action      = "block"
      description = "Block direct origin IP / unknown-host access (homescout hostnames only)"
      enabled     = true
    },
    {
      expression  = "(lower(http.request.uri.path) eq \"/metrics\") or starts_with(lower(http.request.uri.path), \"/metrics/\")"
      action      = "block"
      description = "Block /metrics on the public edge (in-cluster scrape only)"
      enabled     = true
    },
  ]
}
