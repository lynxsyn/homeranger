terraform {
  required_version = ">= 1.5.0, < 2.0.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.19.1"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.0"
    }
  }

  # State stored in Cloudflare R2 via the s3 backend (R2 has S3 API compat).
  # AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY env vars (mapped from R2_KEY_ID
  # + R2_SECRET_KEY locally; repo GH Actions secrets in CI) authenticate.
  #
  # homescout uses its OWN state bucket + key — it shares ZERO state with
  # Doxus. Provision the `homescout-tf-state` R2 bucket (or reuse an existing
  # R2 account-scoped bucket with a homescout/ key prefix) before first init.
  # The R2 account endpoint below is the SAME Cloudflare account Doxus uses
  # (account hash 6108d0d4381a4b61c8d0c9cd9cdf900a). Confirm the bucket name
  # against the R2 dashboard before `tofu init`.
  backend "s3" {
    bucket = "homescout-tf-state"
    key    = "cloudflare/terraform.tfstate"
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
