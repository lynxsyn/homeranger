# ── Cloudflare Tunnel ──
# Outbound-only tunnel fronting the homescout app (app.aid-engineering.com).
# Mirrors Doxus's tunnel pattern: one named tunnel, a config with path-based
# ingress (/api + /ws + /trpc → API service, everything else → web), and a
# proxied CNAME pointing the public hostname at <tunnel-id>.cfargotunnel.com.
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
        # tRPC data plane. The SPA's tRPC client posts to the same-origin
        # relative path "/trpc" (apps/web/src/lib/trpc.ts) and the API mounts
        # the tRPC plugin at prefix "/trpc" (apps/api/src/main.ts) — NOT under
        # /api (only /api/health + /api/version live there). Without this rule
        # "/trpc" falls through to the web catch-all below and nginx returns the
        # index.html SPA shell for every query/mutation, so the whole app is
        # dead through the tunnel. MUST precede the path-less web catch-all
        # (cloudflared matches ingress top-to-bottom). Behind the CF Access app
        # like the rest of app_hostname — correct for the authenticated data plane.
        hostname = var.app_hostname
        path     = "/trpc"
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
        # M4 — Resend inbound/event webhooks. Dedicated public host that maps
        # to the SAME homescout-api Service but is deliberately NOT fronted by
        # the Cloudflare Access app (access.tf scopes the Access application to
        # var.app_hostname only). Resend cannot present a CF Access JWT, so the
        # webhook routes authenticate at the API layer instead: each route
        # verifies the Svix signature (whsec_… secret) on the raw body before
        # doing anything. Mirrors Doxus's edge-public api.doxus.app pattern for
        # its CF Email Routing worker.
        #
        # The api's NetworkPolicy already allows ingress from cloudflared on
        # 3000 (allow-homescout-api) — the same Service answers both hostnames,
        # so no extra netpol is needed for this host.
        hostname = var.webhook_hostname
        service  = "http://homescout-api.homescout.svc.cluster.local:3000"
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

# M4 — Proxied CNAME for the Resend webhook host (var.webhook_hostname, e.g.
# hooks.aid-engineering.com). Pairs with the var.webhook_hostname ingress entry
# in cloudflare_zero_trust_tunnel_cloudflared_config.homescout. NOT covered by
# the CF Access application — webhooks reach the api directly and are
# authenticated by Svix signature verification at the route layer. Proxied so
# Cloudflare's edge (and the custom WAF in waf.tf) still front it.
resource "cloudflare_dns_record" "tunnel_webhook" {
  zone_id = var.zone_id
  name    = var.webhook_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.homescout.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}
