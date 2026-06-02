# ── R2 Object Storage (M4) ──
# Private bucket for inbound-email attachments (PDFs + images the processor
# decodes from Resend inbound-parse payloads and uploads via @aws-sdk/client-s3
# against the R2 S3-compatible endpoint). No public access — the worker writes
# objects directly; nothing serves them over a custom domain.
#
# The bucket lives in the SAME Cloudflare account as Doxus (account_id =
# var.account_id) but is a distinct, homescout-owned bucket (zero shared state
# with doxus-media / doxus-documents). The S3 API endpoint the worker uses is
# https://<account-id>.r2.cloudflarestorage.com (R2_ENDPOINT in the secret) and
# the bucket name is R2_BUCKET = homescout-attachments.
#
# cloudflare_r2_bucket is supported by the pinned provider (cloudflare 5.19.1 —
# same resource Doxus uses in doxus-infra/terraform/cloudflare/r2.tf).
#
# CORS / custom-domain / lifecycle rules are intentionally omitted: the worker
# is the only client and writes server-side with credentials, so there is no
# browser-origin CORS requirement and no public domain binding.
resource "cloudflare_r2_bucket" "attachments" {
  account_id = var.account_id
  name       = "homescout-attachments"
  location   = "WEUR"
}
