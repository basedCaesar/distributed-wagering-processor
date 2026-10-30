#!/usr/bin/env bash
set -euo pipefail

awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true

DLQ_URL=$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

cat > /tmp/wager-transactions-attrs.json <<EOF
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "true",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"20\"}"
}
EOF

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes file:///tmp/wager-transactions-attrs.json

awslocal sns create-topic \
  --name wagering-events.fifo \
  --attributes FifoTopic=true

awslocal sqs create-queue \
  --queue-name wagering-events-auditor.fifo \
  --attributes FifoQueue=true

AUDITOR_URL=$(awslocal sqs get-queue-url --queue-name wagering-events-auditor.fifo --query QueueUrl --output text)
AUDITOR_ARN=$(awslocal sqs get-queue-attributes --queue-url "$AUDITOR_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)
TOPIC_ARN=$(awslocal sns list-topics --query "Topics[?ends_with(TopicArn,':wagering-events.fifo')].TopicArn" --output text)

# LocalStack não aplica policy de fila por padrão; a entrega SNS -> SQS funciona sem ela.
awslocal sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol sqs \
  --notification-endpoint "$AUDITOR_ARN" \
  --attributes RawMessageDelivery=true
