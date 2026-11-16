variable "name" { type = string }
variable "region" { type = string }
variable "vpc_id" { type = string }
variable "private_subnets" { type = list(string) }
variable "public_subnets" { type = list(string) }
variable "certificate_arn" { type = string }
variable "allowed_ingress_cidrs" { type = list(string) }
variable "image" { type = string }
variable "ecr_repository_arn" { type = string }
variable "db_security_group" { type = string }
variable "db_host" { type = string }
variable "db_credentials_secret" { type = string }
variable "db_ca_secret" { type = string }
variable "command_url" { type = string }
variable "command_arn" { type = string }
variable "events_url" { type = string }
variable "events_arn" { type = string }
variable "dlq_url" { type = string }
variable "dlq_arn" { type = string }
variable "oidc_issuer" { type = string }
variable "oidc_audience" { type = string }
variable "desired_count" { type = number }
variable "maximum_count" { type = number }
variable "production" { type = bool }

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.name}"
  retention_in_days = var.production ? 90 : 14
}
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}
resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}
data "aws_iam_policy_document" "execution" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # AWS requires wildcard for this authentication action.
  }
  statement {
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = [var.ecr_repository_arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.db_credentials_secret, var.db_ca_secret]
  }
}
resource "aws_iam_role_policy" "execution" {
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}
data "aws_iam_policy_document" "task" {
  statement {
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "sqs:SendMessage"]
    resources = [var.command_arn] # SendMessage is needed by authorized quarantine redrive.
  }
  statement {
    actions   = ["sqs:SendMessage", "sqs:GetQueueAttributes"]
    resources = [var.events_arn]
  }
  statement {
    actions   = ["sqs:GetQueueAttributes"]
    resources = [var.dlq_arn]
  }
}
resource "aws_iam_role_policy" "task" {
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}
resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  vpc_id      = var.vpc_id
}
resource "aws_security_group" "task" {
  name_prefix = "${var.name}-task-"
  vpc_id      = var.vpc_id
}
resource "aws_vpc_security_group_ingress_rule" "https" {
  for_each          = toset(var.allowed_ingress_cidrs)
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}
resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.task.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}
resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.task.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}
resource "aws_vpc_security_group_egress_rule" "task_https" {
  security_group_id = aws_security_group.task.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}
resource "aws_vpc_security_group_egress_rule" "task_database" {
  security_group_id            = aws_security_group.task.id
  referenced_security_group_id = var.db_security_group
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}
resource "aws_lb" "this" {
  name                       = var.name
  internal                   = false
  load_balancer_type         = "application"
  subnets                    = var.public_subnets
  security_groups            = [aws_security_group.alb.id]
  enable_deletion_protection = var.production
  drop_invalid_header_fields = true
}
resource "aws_lb_target_group" "this" {
  name                 = var.name
  vpc_id               = var.vpc_id
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  deregistration_delay = 30
  health_check {
    path                = "/health/ready"
    matcher             = "200"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}
resource "aws_lb_listener_rule" "financial_api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
  condition {
    path_pattern { values = ["/wallets", "/wallets/*", "/wagering/*"] }
  }
  # /metrics, /health and /admin remain absent from the external listener.
}
resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}
resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name         = "api", image = var.image, essential = true,
    user         = "1000:1000", readonlyRootFilesystem = true,
    portMappings = [{ containerPort = 3000, protocol = "tcp" }],
    stopTimeout  = 120,
    environment = [for key, value in {
      NODE_ENV                  = "production", AUTH_MODE = "oidc", PORT = "3000",
      DB_HOST                   = var.db_host, DB_NAME = "jungle", DB_PORT = "5432", DB_SSL = "true",
      AWS_REGION                = var.region, SQS_QUEUE_URL = var.command_url, SQS_EVENTS_QUEUE_URL = var.events_url,
      SQS_DLQ_QUEUE_URL         = var.dlq_url, ENABLE_SQS_CONSUMER = "true",
      ENABLE_OUTBOX_PUBLISHER   = "true", ENABLE_PENDING_REFERENCE_WORKER = "true",
      ENABLE_DB_METRICS_SAMPLER = "true", OIDC_ISSUER_URL = var.oidc_issuer,
      OIDC_AUDIENCE             = var.oidc_audience
    } : { name = key, value = value }],
    secrets = [
      { name = "DB_USER", valueFrom = "${var.db_credentials_secret}:username::" },
      { name = "DB_PASSWORD", valueFrom = "${var.db_credentials_secret}:password::" },
      { name = "DB_SSL_CA", valueFrom = var.db_ca_secret }
    ],
    healthCheck = {
      command  = ["CMD-SHELL", "bun -e \"fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
      interval = 30, timeout = 5, retries = 3, startPeriod = 60
    },
    logConfiguration = { logDriver = "awslogs", options = {
      awslogs-group = aws_cloudwatch_log_group.this.name, awslogs-region = var.region, awslogs-stream-prefix = "api"
    } }
  }])
}
resource "aws_ecs_service" "this" {
  name                               = var.name
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.this.arn
  desired_count                      = var.desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "1.4.0"
  enable_execute_command             = false
  health_check_grace_period_seconds  = 90
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = var.private_subnets
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = "api"
    container_port   = 3000
  }
  lifecycle {
    ignore_changes = [desired_count]
    precondition {
      condition     = var.desired_count >= 1 && var.maximum_count >= var.desired_count && (!var.production || var.desired_count >= 2)
      error_message = "Capacity must be positive and production requires at least two tasks."
    }
  }
  depends_on = [aws_lb_listener.https, aws_iam_role_policy.task, aws_iam_role_policy.execution]
}
resource "aws_appautoscaling_target" "this" {
  min_capacity       = var.desired_count
  max_capacity       = var.maximum_count
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.this.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}
resource "aws_appautoscaling_policy" "cpu" {
  name               = "${var.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 120
    scale_out_cooldown = 60
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
  }
}
output "task_security_group" { value = aws_security_group.task.id }
output "alb_dns" { value = aws_lb.this.dns_name }
output "cluster" { value = aws_ecs_cluster.this.name }
output "service" { value = aws_ecs_service.this.name }
output "task_definition" { value = aws_ecs_task_definition.this.arn }
