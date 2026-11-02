import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { AppConfig } from "../config/config.schema";

/**
 * Prazo de cada comando curto do consumidor (D21.12): `DeleteMessage` (ack),
 * `ChangeMessageVisibility` e o `SendMessage` da DLQ. Igual ao
 * `statement_timeout` do banco (5 s).
 */
export const SQS_COMMAND_TIMEOUT_MS = 5_000;
/**
 * Margem do `ReceiveMessage` sobre o long poll (D19.9, D21.12): o prazo do
 * receive é `WaitTimeSeconds` + esta margem, nunca o dos comandos curtos.
 */
export const RECEIVE_TIMEOUT_MARGIN_MS = 5_000;

/** Prazo de um `ReceiveMessage` com long poll de `waitTimeSeconds` (D21.12). */
export function receiveTimeoutMs(waitTimeSeconds: number): number {
  return waitTimeSeconds * 1000 + RECEIVE_TIMEOUT_MARGIN_MS;
}

/**
 * Cliente SQS do processo (D21.12). Cada comando tem prazo
 * (`requestTimeout`, por padrão o dos comandos curtos; o receive passa o
 * dele, por chamada) e **uma** tentativa: quem repete é o consumidor (retry
 * da mensagem, D8.2; espera entre receives, D19.10; ack que falhou cai na
 * inbox, D19.4).
 *
 * `throwOnRequestTimeout`: sem ele, o `@smithy/node-http-handler` só
 * **avisa** quando o prazo estoura e a chamada nunca falha; um SQS que
 * aceita a conexão e não responde prendia o consumidor para sempre (mesmo
 * problema do SNS, achado na correção da revisão da S8;
 * `test/integration/messaging/sqs-timeout.spec.ts`).
 *
 * No LocalStack, qualquer par estático de credenciais serve e evita o
 * provider chain da AWS real (como no health).
 */
export function createSqsClient(
  aws: Pick<AppConfig["aws"], "region" | "endpoint">,
  options: { commandTimeoutMs?: number } = {},
): SQSClient {
  const commandTimeoutMs = options.commandTimeoutMs ?? SQS_COMMAND_TIMEOUT_MS;
  return new SQSClient({
    region: aws.region,
    endpoint: aws.endpoint,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
    requestHandler: {
      requestTimeout: commandTimeoutMs,
      connectionTimeout: commandTimeoutMs,
      throwOnRequestTimeout: true,
    },
  });
}

export async function queueUrlOf(client: SQSClient, queueName: string): Promise<string> {
  const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (!QueueUrl) throw new Error(`fila ${queueName} sem URL`);
  return QueueUrl;
}
