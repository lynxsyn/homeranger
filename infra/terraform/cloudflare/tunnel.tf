# ── Cloudflare Tunnel ──
# Outbound-only tunnel fronting the homeranger app (homeranger.app).
# Mirrors Doxus's tunnel pattern: one named tunnel, a config with path-based
# ingress (/api + /ws + /trpc → API service, everything else → web), and a
# proxied CNAME pointing the public hostname at <tunnel-id>.cfargotunnel.com.
#
# The cluster-internal service targets use the homeranger namespace and the
# @homeranger/api + @homeranger/web service names. Adjust the Service DNS names
# if the K8s Service objects are named differently in infra/deploy.

resource "random_id" "tunnel_secret" {
  byte_length = 32
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "homeranger" {
  account_id    = var.account_id
  name          = "homeranger"
  config_src    = "cloudflare"
  tunnel_secret = var.tunnel_secret != "" ? var.tunnel_secret : base64encode(random_id.tunnel_secret.hex)

  lifecycle {
    ignore_changes = [tunnel_secret]
  }
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "homeranger" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.homeranger.id
  source     = "cloudflare"
  config = {
    ingress = [
      {
        hostname = var.app_hostname
        path     = "/api"
        service  = "http://homeranger-api.homeranger.svc.cluster.local:3000"
      },
      {
        hostname = var.app_hostname
        path     = "/ws"
        service  = "http://homeranger-api.homeranger.svc.cluster.local:3000"
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
        service  = "http://homeranger-api.homeranger.svc.cluster.local:3000"
      },
      {
        # Resend webhooks (inbound-parse + delivery/event) — /webhooks/* on the
        # SAME homeranger.app host, routed to the api. Cloudflare Access BYPASSES
        # this path (access.tf cloudflare_zero_trust_access_application.webhooks)
        # since Resend can't present an Access JWT; each route still verifies the
        # Svix signature on the raw body. MUST precede the web catch-all below
        # (cloudflared matches top-to-bottom).
        hostname = var.app_hostname
        path     = "/webhooks"
        service  = "http://homeranger-api.homeranger.svc.cluster.local:3000"
      },
      {
        # SPA / static web. If the web app is served from Cloudflare Pages
        # instead of an in-cluster Service, swap this for the Pages origin
        # + origin_request httpHostHeader/originServerName rewrite (see the
        # Doxus tunnel.tf Pages pattern). Default here is in-cluster web.
        hostname = var.app_hostname
        service  = "http://homeranger-web.homeranger.svc.cluster.local:8080"
      },
      {
        service = "http_status:404"
      },
    ]
  }
}

# ── DNS record ──
# Proxied CNAME routing var.app_hostname (homeranger.app) through the
# tunnel. Uses var.app_hostname so the published host matches the ingress
# `hostname` blocks above exactly (no subdomain divergence).
resource "cloudflare_dns_record" "tunnel_app" {
  zone_id = var.zone_id
  name    = var.app_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.homeranger.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

# Webhooks now live at homeranger.app/webhooks (a path on the apex tunnel CNAME
# above), Access-bypassed per access.tf — so there is no separate webhook host.
