# Supabase config (Terraform)

Manages the **homeranger** Supabase project (`jdaklyjwxymrahnbuczi`) **auth
configuration as code**, via the
[`supabase/supabase`](https://registry.terraform.io/providers/supabase/supabase/latest)
provider. Lives alongside the `cloudflare` module so there is **one** IaC system
for all infrastructure config.

## What this module owns (non-secret auth config)

| Setting | Value | Why |
|---|---|---|
| `external_email_enabled` | `true` | email + password / magic-link auth on |
| `mailer_autoconfirm` | `false` | email confirmation stays **required** |
| `site_url` | `https://homeranger.app` | default auth-redirect target (prod app) |
| `uri_allow_list` | `homeranger.app` + `localhost:3000` (+ `/**`) | allowed redirects (prod + local dev) |
| `rate_limit_email_sent` | `100`/hr | lifted off the tiny built-in default |
| `mailer_otp_exp` | `86400` (24h) | confirmation / recovery link validity |

## What this module does NOT own — SMTP

SMTP (the transport **and** the Resend sending key) is owned by the
**Supabase ↔ Resend native integration**
(Dashboard → Authentication → Emails → SMTP), sending as:

```
HomeRanger <noreply@homeranger.app>      # Resend; domain homeranger.app verified
```

SMTP is intentionally kept out of Terraform because:

1. the provider returns `smtp_pass` as a **hash**, so managing it produces a
   permanent `terraform plan` diff that never converges; and
2. the Resend API key would otherwise be written into the R2-backed `.tfstate`
   — needless secret sprawl.

The sending credential is a **restricted Resend "Sending access" key** scoped to
`homeranger.app` (separate from the app's outreach key, independently
revocable). An `apply` only PATCHes the keys listed above, so it never disturbs
the integration's SMTP settings.

## Apply

State lives in the shared `homeranger-tf-state` R2 bucket under
`supabase/terraform.tfstate`.

```sh
# R2 (S3-compatible) backend creds — mapped from .env
export AWS_ACCESS_KEY_ID="$R2_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_KEY"

# Supabase personal access token: Dashboard → Account → Access Tokens.
# Sensitive — never committed (like the cloudflare module's CF token).
export SUPABASE_ACCESS_TOKEN="sbp_..."

terraform init
terraform plan      # review: should touch ONLY the auth keys above, never smtp_*
terraform apply
```

CI injects the same three values from repo secrets.
