locals { name = "jungle-${var.environment}" }
module "network" {
  source     = "./modules/network"
  name       = local.name
  cidr       = var.vpc_cidr
  azs        = var.availability_zones
  single_nat = var.single_nat
}
module "data" {
  source          = "./modules/data"
  name            = local.name
  private_subnets = module.network.private_subnets
  vpc_id          = module.network.vpc_id
  instance_class  = var.db_instance_class
  production      = var.environment == "prod"
  alarm_topic     = var.alarm_sns_topic_arn
}
module "runtime" {
  source                = "./modules/runtime"
  name                  = local.name
  region                = var.region
  vpc_id                = module.network.vpc_id
  private_subnets       = module.network.private_subnets
  public_subnets        = module.network.public_subnets
  certificate_arn       = var.certificate_arn
  allowed_ingress_cidrs = var.allowed_ingress_cidrs
  image                 = var.image
  ecr_repository_arn    = var.ecr_repository_arn
  db_security_group     = module.data.database_security_group
  db_host               = module.data.database_host
  db_credentials_secret = var.database_credentials_secret_arn
  db_ca_secret          = var.database_ca_secret_arn
  command_url           = module.data.command_url
  command_arn           = module.data.command_arn
  events_url            = module.data.events_url
  events_arn            = module.data.events_arn
  dlq_url               = module.data.dlq_url
  dlq_arn               = module.data.dlq_arn
  oidc_issuer           = var.oidc_issuer
  oidc_audience         = var.oidc_audience
  desired_count         = var.desired_count
  maximum_count         = var.maximum_count
  production            = var.environment == "prod"
}
resource "aws_vpc_security_group_ingress_rule" "database_from_tasks" {
  security_group_id            = module.data.database_security_group
  referenced_security_group_id = module.runtime.task_security_group
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}
