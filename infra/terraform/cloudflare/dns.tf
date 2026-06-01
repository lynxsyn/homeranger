# Email DNS — Resend (dedicated sending domain = var.mail_subdomain, the apex
# aid-engineering.com; a domain bought solely for homescout so cold-send
# reputation is isolated from any personal/company domain).
#
# Resend issues the EXACT DKIM / Return-Path target hostnames only AFTER the
# sending domain is added in the Resend dashboard and verification starts.
# Add `aid-engineering.com` as a domain in Resend, copy the records it
# shows, and replace the RESEND_DKIM_*_PLACEHOLDER values below — then
# `tofu plan` / `tofu apply`. Until then these resources will plan with
# placeholder content and email will NOT verify.
#
# Resend's standard record set (region us-east-1 / eu-west-1 differ only in
# the SPF include host and the bounce/feedback target — confirm in the
# dashboard). Every record name is built from var.mail_subdomain as a full
# FQDN, so the module has a single source of truth for the sending domain.

# --- DKIM ---
# Resend issues a single CNAME of the form
#   resend._domainkey.aid-engineering.com -> <selector>.dkim.<region>.amazonses.com
# (older accounts get a TXT public-key record instead — if the dashboard
# shows a TXT, switch this resource to type = "TXT" and put the p= value in
# content). Mirror whatever the dashboard shows.
resource "cloudflare_dns_record" "resend_dkim" {
  zone_id = var.zone_id
  name    = "resend._domainkey.${var.mail_subdomain}"
  type    = "CNAME"
  content = "RESEND_DKIM_CNAME_TARGET_PLACEHOLDER" # e.g. <selector>.dkim.amazonses.com — copy from Resend dashboard
  ttl     = 3600
  proxied = false
}

# --- Return-Path / MAIL FROM (bounce + feedback alignment) ---
# Resend publishes a `send.aid-engineering.com` subdomain for the
# MAIL FROM / Return-Path so SPF + bounces align with the sending domain.
# It typically issues:
#   1. An MX on send.<sub> -> feedback-smtp.<region>.amazonses.com (prio 10)
#   2. A TXT on send.<sub> -> "v=spf1 include:amazonses.com ~all"
# Newer Resend accounts may instead issue a single CNAME — match the
# dashboard. Both forms are provided; delete the one Resend does NOT show.
resource "cloudflare_dns_record" "resend_return_path_mx" {
  zone_id  = var.zone_id
  name     = "send.${var.mail_subdomain}"
  type     = "MX"
  content  = "RESEND_DKIM_RETURN_PATH_MX_PLACEHOLDER" # e.g. feedback-smtp.us-east-1.amazonses.com — copy from Resend
  priority = 10
  ttl      = 3600
}

resource "cloudflare_dns_record" "resend_return_path_spf" {
  zone_id = var.zone_id
  name    = "send.${var.mail_subdomain}"
  type    = "TXT"
  content = "\"v=spf1 include:amazonses.com ~all\""
  ttl     = 3600
  proxied = false
}

# --- SPF for the sending subdomain itself ---
# Resend sends through Amazon SES infra; the apex sending subdomain carries
# its own SPF so envelope-from alignment passes. If Resend's dashboard shows
# a different include host (region-specific), match it exactly.
resource "cloudflare_dns_record" "spf" {
  zone_id = var.zone_id
  name    = var.mail_subdomain
  type    = "TXT"
  content = "\"v=spf1 include:amazonses.com ~all\""
  ttl     = 3600
  proxied = false
}

# --- DMARC ---
# Start at p=none during warmup so legitimate mail is never silently dropped
# while DKIM/SPF alignment is being confirmed via the rua aggregate reports.
# Once reports show 100% aligned pass for ~1-2 weeks, tighten to
#   p=quarantine  (Doxus runs p=quarantine on its production sending domain)
# and eventually p=reject. Update the content string and re-apply.
# rua mailbox: point at an address you actually monitor (placeholder below).
resource "cloudflare_dns_record" "dmarc" {
  zone_id = var.zone_id
  name    = "_dmarc.${var.mail_subdomain}"
  type    = "TXT"
  content = "\"v=DMARC1; p=none; rua=mailto:dmarc@aid-engineering.com; fo=1\""
  ttl     = 3600
  proxied = false
}
