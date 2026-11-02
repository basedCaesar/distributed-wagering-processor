import { ListTopicsCommand, SNSClient } from "@aws-sdk/client-sns";
import type { AppConfig } from "../config/config.schema";

/**
 * Cliente SNS do publisher (D9.1, D20.5). `requestTimeout` abaixo do lease
 * e **uma** tentativa por chamada: a repetição é do publisher, com backoff.
 * Com os 3 `maxAttempts` padrão do SDK, uma chamada lenta poderia passar
 * do lease. No LocalStack, credenciais estáticas (como o SQS).
 *
 * `throwOnRequestTimeout`: sem ele, o `@smithy/node-http-handler` só
 * **avisa** quando o `requestTimeout` estoura, e a chamada nunca falha: um
 * SNS que aceita a conexão e não responde prendia o publisher para sempre
 * (achado na correção da revisão da S8; `test/integration/outbox/sns-timeout.spec.ts`).
 */
export function createSnsClient(
  aws: Pick<AppConfig["aws"], "region" | "endpoint">,
  options: { requestTimeoutMs: number },
): SNSClient {
  return new SNSClient({
    region: aws.region,
    endpoint: aws.endpoint,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
    requestHandler: {
      requestTimeout: options.requestTimeoutMs,
      connectionTimeout: options.requestTimeoutMs,
      throwOnRequestTimeout: true,
    },
  });
}

/** Nome do tópico → ARN, pela listagem (D20.9). Resolvido na subida do processo. */
export async function topicArnOf(client: SNSClient, topicName: string): Promise<string> {
  let nextToken: string | undefined;
  do {
    const page = await client.send(new ListTopicsCommand({ NextToken: nextToken }));
    const match = page.Topics?.find((topic) => topic.TopicArn?.endsWith(`:${topicName}`));
    if (match?.TopicArn) return match.TopicArn;
    nextToken = page.NextToken;
  } while (nextToken);
  throw new Error(`tópico ${topicName} não encontrado`);
}
