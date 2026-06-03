terraform {
  required_version = ">= 1.5.0, < 2.0.0"

  required_providers {
    supabase = {
      source  = "supabase/supabase"
      version = "1.9.1"
    }
  }

  # State lives in the SAME Cloudflare R2 bucket as the cloudflare module, under
  # a distinct key (zero shared state). R2 speaks the S3 API; the backend creds
  # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are mapped from R2_KEY_ID /
  # R2_SECRET_KEY (.env locally; repo GH Actions secrets in CI). See README.md.
  backend "s3" {
    bucket = "homeranger-tf-state"
    key    = "supabase/terraform.tfstate"
    region = "auto"
    endpoints = {
      s3 = "https://6108d0d4381a4b61c8d0c9cd9cdf900a.r2.cloudflarestorage.com"
    }
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_lockfile                = true
  }
}
