# Supabase project (jdaklyjwxymrahnbuczi) auth configuration — managed as code.
#
# SCOPE — this module owns the NON-SECRET GoTrue auth config: Site URL, the
# redirect allow-list, the email send rate limit, and "keep email confirmation
# ON". It deliberately does NOT manage SMTP.
#
# SMTP (transport + the Resend sending key) is owned by the Supabase <-> Resend
# native integration (Dashboard -> Authentication -> Emails -> SMTP), sending as
# "HomeRanger <noreply@homeranger.app>" over the verified homeranger.app domain.
# SMTP is kept out of Terraform on purpose because:
#   1. the provider returns smtp_pass as a HASH -> managing it produces a
#      permanent `terraform plan` diff that never converges; and
#   2. the Resend API key would otherwise be written into the R2-backed
#      tfstate -- needless secret sprawl.
# The provider PATCHes only the keys present in `auth` below, so the
# integration's smtp_* settings are left untouched by an apply. See README.md.
#
# Provider auth: the SUPABASE_ACCESS_TOKEN env var (a Supabase personal access
# token). Sensitive; never committed; exported at apply time exactly like the
# cloudflare module's TF_VAR_cloudflare_api_token.
provider "supabase" {}

resource "supabase_settings" "homeranger" {
  project_ref = var.project_ref

  auth = jsonencode({
    # Email auth on; confirmation stays REQUIRED now that Resend delivers it.
    external_email_enabled = true
    mailer_autoconfirm     = false

    # Where confirmation / magic-link / recovery links point, and which
    # post-auth redirect targets are accepted (dev localhost + prod app).
    site_url       = var.site_url
    uri_allow_list = join(",", var.additional_redirect_urls)

    # Lifted off the tiny built-in default since Resend now handles volume.
    rate_limit_email_sent = var.email_rate_limit_per_hour

    # Confirmation / recovery links stay valid for 24h.
    mailer_otp_exp = 86400
  })
}
