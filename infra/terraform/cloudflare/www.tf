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

# 301 www → apex redirect: NOT managed here. The scoped CF API token
# (HOMERANGER_CF_API_TOKEN) is authorized for DNS + Access + firewall rulesets
# but NOT for the dynamic_redirect ruleset phase OR Page Rules (both return 403),
# so the redirect is created out-of-band in the Cloudflare dashboard:
#   Rules → Redirect Rules → Create:  When  hostname equals  www.homeranger.app
#   Then  Static/Dynamic 301 → concat("https://homeranger.app", http.request.uri.path)  (preserve query).
# Until then www resolves (record above) but returns the tunnel 404; with the
# redirect, www.homeranger.app/<path> → https://homeranger.app/<path>.
# (To manage it in IaC, grant the token "Zone → Dynamic Redirect → Edit" and add
# a cloudflare_ruleset { phase = "http_request_dynamic_redirect" } here.)
