terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.90" }
  }
  # Configure an encrypted, access-controlled remote backend before any real plan/apply.
}
provider "aws" {
  region = var.region
  default_tags { tags = { Application = "jungle", Environment = var.environment, ManagedBy = "terraform" } }
}
