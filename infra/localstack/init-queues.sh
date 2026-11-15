#!/usr/bin/env bash
set -euo pipefail

region="${AWS_DEFAULT_REGION:-us-east-1}"
endpoint="http://localhost:4566"

aws() {
  AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}" \
  AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}" \
  AWS_DEFAULT_REGION="$region" \
  command aws --endpoint-url "$endpoint" "$@"
}

aws sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true,VisibilityTimeout=30 \
  >/dev/null

dead_letter_arn="$(aws sqs get-queue-attributes \
  --queue-url "$endpoint/000000000000/wager-transactions-dlq.fifo" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"

redrive_policy="{\"deadLetterTargetArn\":\"$dead_letter_arn\",\"maxReceiveCount\":\"${SQS_MAX_RECEIVE_COUNT:-3}\"}"
aws sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"true\",\"VisibilityTimeout\":\"${SQS_VISIBILITY_TIMEOUT:-30}\",\"RedrivePolicy\":$(printf '%s' "$redrive_policy" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))') }" \
  >/dev/null

aws sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true,VisibilityTimeout=30 \
  >/dev/null

echo 'LocalStack SQS queues initialized: commands FIFO, DLQ FIFO and events FIFO.'
