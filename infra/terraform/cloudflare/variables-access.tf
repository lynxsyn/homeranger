# Cloudflare Access variables (separate file for a cleaner reviewable diff;
# Terraform merges all *.tf in the directory).

variable "owner_email" {
  description = "The operator email allowed through Cloudflare Access for the homeranger app (homeranger.app). Also the ALLOWED_USER_EMAIL the api maps to the operator (NULL) data namespace."
  type        = string
}

variable "second_user_email" {
  description = "An additional email allowed through Cloudflare Access (the edge allowlist). Empty = owner only. The user still signs in with Supabase in-app; this only controls who reaches the app at the edge."
  type        = string
  default     = ""
}
