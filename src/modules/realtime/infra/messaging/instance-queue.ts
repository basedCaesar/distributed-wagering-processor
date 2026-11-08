import { GetQueueUrlCommand, QueueDoesNotExist, type SQSClient } from "@aws-sdk/client-sqs";

/**
 * A fila da instância (D28.5) vem da infra, já assinada no tópico (o
 * `localstack-init.sh` cria as de `realtime-1` e `realtime-2`). O
 * realtime só usa SQS: nunca toca no SNS (D20.10). Sem a fila, a subida
 * falha com uma mensagem que diz o que falta.
 */
export async function resolveInstanceQueueUrl(sqs: SQSClient, queueName: string): Promise<string> {
  try {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (QueueUrl) return QueueUrl;
  } catch (error) {
    if (!(error instanceof QueueDoesNotExist)) throw error;
  }
  throw new Error(
    `fila ${queueName} não existe: a infra cria a fila da instância já assinada no tópico (scripts/localstack-init.sh, D28.5)`,
  );
}
