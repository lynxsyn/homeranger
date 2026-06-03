# Cloudflare Access variables (separate file for a cleaner reviewable diff;
# Terraform merges all *.tf in the directory).

variable "owner_email" {
  description = "The single owner email allowed through Cloudflare Access for the homeranger app (homeranger.app). This is the ALLOWED_USER_EMAIL the api enforces on the verified JWT."
  type        = string
}
