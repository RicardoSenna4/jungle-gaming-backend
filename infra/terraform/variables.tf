variable "environment" {
  type = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Use dev, staging or prod."
  }
}
variable "region" { type = string }
variable "availability_zones" {
  type = list(string)
  validation {
    condition     = length(distinct(var.availability_zones)) == 2
    error_message = "Exactly two availability zones are required."
  }
}
variable "vpc_cidr" { type = string }
variable "single_nat" { type = bool }
variable "certificate_arn" { type = string }
variable "image" {
  type = string
  validation {
    condition     = can(regex("@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Use an immutable ECR image digest."
  }
}
variable "ecr_repository_arn" { type = string }
variable "database_credentials_secret_arn" {
  type        = string
  description = "Pre-provisioned secret JSON username,password for a non-master application DB role."
}
variable "database_ca_secret_arn" {
  type        = string
  description = "Secret string containing the trusted AWS RDS CA PEM bundle."
}
variable "oidc_issuer" {
  type = string
  validation {
    condition     = startswith(var.oidc_issuer, "https://")
    error_message = "HTTPS OIDC issuer required."
  }
}
variable "oidc_audience" { type = string }
variable "allowed_ingress_cidrs" {
  type        = list(string)
  description = "Approved API client/network CIDRs; no default public exposure."
}
variable "db_instance_class" { type = string }
variable "desired_count" { type = number }
variable "maximum_count" { type = number }
variable "alarm_sns_topic_arn" {
  type        = string
  default     = null
  description = "Optional pre-approved alert topic; notification delivery must be tested separately."
}
