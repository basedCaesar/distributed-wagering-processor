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

# DLQ do auditor (D20.2): permanentes copiados pelo próprio auditor; o redrive é a rede de segurança.
awslocal sqs create-queue \
  --queue-name wagering-events-auditor-dlq.fifo \
  --attributes FifoQueue=true

AUDITOR_DLQ_URL=$(awslocal sqs get-queue-url --queue-name wagering-events-auditor-dlq.fifo --query QueueUrl --output text)
AUDITOR_DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$AUDITOR_DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

cat > /tmp/wagering-events-auditor-attrs.json <<EOF
{
  "FifoQueue": "true",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${AUDITOR_DLQ_ARN}\",\"maxReceiveCount\":\"20\"}"
}
EOF

awslocal sqs create-queue \
  --queue-name wagering-events-auditor.fifo \
  --attributes file:///tmp/wagering-events-auditor-attrs.json

AUDITOR_URL=$(awslocal sqs get-queue-url --queue-name wagering-events-auditor.fifo --query QueueUrl --output text)
AUDITOR_ARN=$(awslocal sqs get-queue-attributes --queue-url "$AUDITOR_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)
TOPIC_ARN=$(awslocal sns list-topics --query "Topics[?ends_with(TopicArn,':wagering-events.fifo')].TopicArn" --output text)

# LocalStack não aplica policy de fila por padrão; a entrega SNS -> SQS funciona sem ela.
awslocal sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol sqs \
  --notification-endpoint "$AUDITOR_ARN" \
  --attributes RawMessageDelivery=true

# Partidas dobradas (D27.5): fila assinante própria, DLQ própria, o mesmo redrive do auditor.
awslocal sqs create-queue \
  --queue-name wagering-events-accounting-dlq.fifo \
  --attributes FifoQueue=true

ACCOUNTING_DLQ_URL=$(awslocal sqs get-queue-url --queue-name wagering-events-accounting-dlq.fifo --query QueueUrl --output text)
ACCOUNTING_DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$ACCOUNTING_DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

cat > /tmp/wagering-events-accounting-attrs.json <<EOF
{
  "FifoQueue": "true",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${ACCOUNTING_DLQ_ARN}\",\"maxReceiveCount\":\"20\"}"
}
EOF

awslocal sqs create-queue \
  --queue-name wagering-events-accounting.fifo \
  --attributes file:///tmp/wagering-events-accounting-attrs.json

ACCOUNTING_URL=$(awslocal sqs get-queue-url --queue-name wagering-events-accounting.fifo --query QueueUrl --output text)
ACCOUNTING_ARN=$(awslocal sqs get-queue-attributes --queue-url "$ACCOUNTING_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

awslocal sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol sqs \
  --notification-endpoint "$ACCOUNTING_ARN" \
  --attributes RawMessageDelivery=true

# Tempo real (D28.5): uma fila por instância do realtime, com o id estável
# dela, já assinada no tópico. Sem DLQ (exceção da D28.7); retenção de 300 s,
# porque evento velho não serve como notificação. O realtime só usa SQS: o
# SNS fica só no publisher (D20.10).
for INSTANCE in realtime-1 realtime-2; do
  awslocal sqs create-queue \
    --queue-name "wagering-events-realtime-${INSTANCE}.fifo" \
    --attributes FifoQueue=true,MessageRetentionPeriod=300,VisibilityTimeout=30

  REALTIME_URL=$(awslocal sqs get-queue-url --queue-name "wagering-events-realtime-${INSTANCE}.fifo" --query QueueUrl --output text)
  REALTIME_ARN=$(awslocal sqs get-queue-attributes --queue-url "$REALTIME_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

  awslocal sns subscribe \
    --topic-arn "$TOPIC_ARN" \
    --protocol sqs \
    --notification-endpoint "$REALTIME_ARN" \
    --attributes RawMessageDelivery=true
done
