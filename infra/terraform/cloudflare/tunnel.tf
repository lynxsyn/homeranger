# ── Cloudflare Tunnel ──
# Outbound-only tunnel fronting the homescout app (app.aid-engineering.com).
# Mirrors Doxus's tunnel pattern: one named tunnel, a config with path-based
# ingress (/api + /ws → API service, everything else → web), and a proxied
# CNAME pointing the public hostname at <tunnel-id>.cfargotunnel.com.
#
# The cluster-internal service targets use the homescout namespace and the
# @homescout/api + @homescout/web service names. Adjust the Service DNS names
# if the K8s Service objects are named differently in infra/deploy.

resource "random_id" "tunnel_secret" {
  byte_length = 32
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "homescout" {
  account_id    = var.account_id
  name          = "homescout"
  config_src    = "cloudflare"
  tunnel_secret = var.tunnel_secret != "" ? var.tunnel_secret : base64encode(random_id.tunnel_secret.hex)

  lifecycle {
    ignore_changes = [tunnel_secret]
  }
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "homescout" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.homescout.id
  source     = "cloudflare"
  config = {
    ingress = [
      {
        hostname = var.app_hostname
        path     = "/api"
        service  = "http://homescout-api.homescout.svc.cluster.local:3000"
      },
      {
        hostname = var.app_hostname
        path     = "/ws"
        service  = "http://homescout-api.homescout.svc.cluster.local:3000"
      },
      {
        # SPA / static web. If the web app is served from Cloudflare Pages
        # instead of an in-cluster Service, swap this for the Pages origin
        # + origin_request httpHostHeader/originServerName rewrite (see the
        # Doxus tunnel.tf Pages pattern). Default here is in-cluster web.
        hostname = var.app_hostname
        service  = "http://homescout-web.homescout.svc.cluster.local:8080"
      },
      {
        service = "http_status:404"
      },
    ]
  }
}

# ── DNS record ──
# Proxied CNAME routing var.app_hostname (app.aid-engineering.com) through the
# tunnel. Uses var.app_hostname so the published host matches the ingress
# `hostname` blocks above exactly (no subdomain divergence).
resource "cloudflare_dns_record" "tunnel_app" {
  zone_id = var.zone_id
  name    = var.app_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.homescout.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}
