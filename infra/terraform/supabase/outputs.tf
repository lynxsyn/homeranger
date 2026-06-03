output "project_ref" {
  description = "The Supabase project this module configures."
  value       = var.project_ref
}

output "auth_site_url" {
  description = "Configured primary Site URL for auth redirects."
  value       = var.site_url
}

output "auth_redirect_allow_list" {
  description = "Redirect targets accepted after auth (GoTrue uri_allow_list)."
  value       = var.additional_redirect_urls
}
