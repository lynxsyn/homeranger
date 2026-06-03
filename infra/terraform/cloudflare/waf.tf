# ── Custom WAF (M4) ──
# Mirrors doxus-infra/terraform/cloudflare/waf.tf, scoped to homeranger's
# single public hostname (the apex, var.app_hostname). Two load-bearing rules:
#
#   1. Origin-IP / unknown-host block — any request whose Host is NOT
#      homeranger.app is dropped at the edge, so the tunnel origin is never
#      reachable by raw IP or a spoofed Host. The Resend webhooks are no longer
#      a separate host: they live at homeranger.app/webhooks (a path on this
#      same apex, tunnel-routed to the api and Access-bypassed in access.tf), so
#      they pass this rule like any other apex request — no allowlist entry for
#      a webhook host is needed anymore.
#   2. /metrics block — the api (and processor, in-cluster) expose Prometheus
#      metrics; the public edge must never serve them (leaks queue depths,
#      route names, error counts). In-cluster scrapes hit the Service directly
#      and never traverse Cloudflare, so this only affects public traffic.
#
# NOTE: this ruleset runs on the SHARED homeranger.app zone. If a future
# tenant / sibling app adds its own hostnames on this zone, append them to the
# allowlist expression (rule 1) or it will block them. Keep this in sync with
# the tunnel ingress `hostname` blocks in tunnel.tf.
resource "cloudflare_ruleset" "custom_waf" {
  zone_id = var.zone_id
  name    = "homeranger Custom WAF Rules"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  rules = [
    {
      expression  = "(http.host ne \"${var.app_hostname}\")"
      action      = "block"
      description = "Block direct origin IP / unknown-host access (homeranger.app only)"
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
