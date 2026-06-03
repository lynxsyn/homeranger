# ── www → apex redirect ──
# Cloudflare warns "Visitors cannot reach www.homeranger.app" until www has a
# record. We point www at the SAME tunnel CNAME as the apex (proxied) so the
# request reaches Cloudflare's edge, and a Single Redirect (dynamic_redirect
# phase, which runs BEFORE the custom WAF) 301s every www request to the
# canonical apex, preserving the path + query. So visitors who type
# www.homeranger.app land on https://homeranger.app/… instead of an error.

resource "cloudflare_dns_record" "www" {
  zone_id = var.zone_id
  name    = "www.${var.app_hostname}"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.homeranger.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

resource "cloudflare_ruleset" "www_redirect" {
  zone_id = var.zone_id
  name    = "www → apex redirect"
  kind    = "zone"
  phase   = "http_request_dynamic_redirect"

  rules = [
    {
      ref         = "www_to_apex"
      description = "301 www.${var.app_hostname} → ${var.app_hostname} (canonical apex)"
      expression  = "(http.host eq \"www.${var.app_hostname}\")"
      action      = "redirect"
      enabled     = true
      action_parameters = {
        from_value = {
          status_code = 301
          target_url = {
            expression = "concat(\"https://${var.app_hostname}\", http.request.uri.path)"
          }
          preserve_query_string = true
        }
      }
    },
  ]
}
