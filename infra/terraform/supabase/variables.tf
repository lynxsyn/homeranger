variable "project_ref" {
  description = "Supabase project reference ID (the subdomain of the project's API URL)."
  type        = string
  default     = "jdaklyjwxymrahnbuczi"
}

variable "site_url" {
  description = "Primary Site URL — the default target for auth email redirect links (the production app)."
  type        = string
  default     = "https://homeranger.app"
}

variable "additional_redirect_urls" {
  description = "Allowed post-auth redirect targets (prod + local dev, with wildcards). Joined into the GoTrue uri_allow_list."
  type        = list(string)
  default = [
    "https://homeranger.app",
    "https://homeranger.app/**",
    "http://localhost:3000",
    "http://localhost:3000/**",
  ]
}

variable "email_rate_limit_per_hour" {
  description = "Max auth emails GoTrue sends per hour. Raised above the tiny built-in default now that custom SMTP (Resend) is configured."
  type        = number
  default     = 100
}
