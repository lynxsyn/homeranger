provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# aid-engineering.com is an EXISTING zone in the same Cloudflare account Doxus
# uses (account user lynx.synthacon). homescout does NOT own the zone — it
# only adds a dedicated sending subdomain (aid-engineering.com) plus the
# app ingress hostname. So the zone is referenced via the var.zone_id input
# (sourced from the SOPS tfvars, mirroring Doxus's dns.tf which uses
# var.zone_id directly rather than a managed cloudflare_zone resource).
#
# Do NOT add a `resource "cloudflare_zone"` here — that would attempt to
# take ownership of aid-engineering.com and clobber any sibling records (e.g. a
# Doxus-unrelated app or a future tenant) living on the same zone.
