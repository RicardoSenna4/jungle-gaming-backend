variable "name" { type = string }
variable "private_subnets" { type = list(string) }
variable "vpc_id" { type = string }
variable "instance_class" { type = string }
variable "production" { type = bool }
variable "alarm_topic" {
  type    = string
  default = null
}
resource "aws_security_group" "database" {
  name_prefix = "${var.name}-database-"
  vpc_id      = var.vpc_id
  description = "PostgreSQL: only explicitly authorized ECS tasks"
}
resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.private_subnets
}
resource "aws_db_parameter_group" "this" {
  name_prefix = "${var.name}-"
  family      = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}
resource "aws_db_instance" "this" {
  identifier                      = var.name
  engine                          = "postgres"
  engine_version                  = "16"
  instance_class                  = var.instance_class
  allocated_storage               = 20
  max_allocated_storage           = 100
  storage_type                    = "gp3"
  storage_encrypted               = true
  db_name                         = "jungle"
  username                        = "jungle_bootstrap"
  manage_master_user_password     = true
  db_subnet_group_name            = aws_db_subnet_group.this.name
  vpc_security_group_ids          = [aws_security_group.database.id]
  parameter_group_name            = aws_db_parameter_group.this.name
  publicly_accessible             = false
  multi_az                        = var.production
  backup_retention_period         = var.production ? 35 : 7
  backup_window                   = "03:00-04:00"
  maintenance_window              = "sun:04:00-sun:05:00"
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${var.name}-final"
  copy_tags_to_snapshot           = true
  auto_minor_version_upgrade      = true
  apply_immediately               = false
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
}
resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name}-commands-dlq.fifo"
  fifo_queue                = true
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
}
resource "aws_sqs_queue" "commands" {
  name                        = "${var.name}-commands.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  sqs_managed_sse_enabled     = true
  visibility_timeout_seconds  = 60
  message_retention_seconds   = 345600
  redrive_policy              = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dlq.arn, maxReceiveCount = 3 })
}
resource "aws_sqs_queue_redrive_allow_policy" "this" {
  queue_url            = aws_sqs_queue.dlq.id
  redrive_allow_policy = jsonencode({ redrivePermission = "byQueue", sourceQueueArns = [aws_sqs_queue.commands.arn] })
}
resource "aws_sqs_queue" "events" {
  name                        = "${var.name}-events.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  sqs_managed_sse_enabled     = true
  message_retention_seconds   = 1209600
  visibility_timeout_seconds  = 60
}
data "aws_iam_policy_document" "tls" {
  for_each = { commands = aws_sqs_queue.commands.arn, events = aws_sqs_queue.events.arn, dlq = aws_sqs_queue.dlq.arn }
  statement {
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [each.value]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}
resource "aws_sqs_queue_policy" "tls" {
  for_each  = { commands = aws_sqs_queue.commands.id, events = aws_sqs_queue.events.id, dlq = aws_sqs_queue.dlq.id }
  queue_url = each.value
  policy    = data.aws_iam_policy_document.tls[each.key].json
}
resource "aws_cloudwatch_metric_alarm" "dlq" {
  alarm_name          = "${var.name}-dlq-not-empty"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dlq.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "missing"
  alarm_actions       = var.alarm_topic == null ? [] : [var.alarm_topic]
}
output "database_host" { value = aws_db_instance.this.address }
output "database_security_group" { value = aws_security_group.database.id }
output "master_secret_arn" { value = aws_db_instance.this.master_user_secret[0].secret_arn }
output "command_url" { value = aws_sqs_queue.commands.url }
output "command_arn" { value = aws_sqs_queue.commands.arn }
output "events_url" { value = aws_sqs_queue.events.url }
output "events_arn" { value = aws_sqs_queue.events.arn }
output "dlq_url" { value = aws_sqs_queue.dlq.url }
output "dlq_arn" { value = aws_sqs_queue.dlq.arn }
