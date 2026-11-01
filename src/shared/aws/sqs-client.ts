import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { AppConfig } from "../config/config.schema";

/**
 * Cliente SQS do processo. No LocalStack, qualquer par estático de
 * credenciais serve e evita o provider chain da AWS real (como no health).
 */
export function createSqsClient(aws: Pick<AppConfig["aws"], "region" | "endpoint">): SQSClient {
  return new SQSClient({
    region: aws.region,
    endpoint: aws.endpoint,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

export async function queueUrlOf(client: SQSClient, queueName: string): Promise<string> {
  const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (!QueueUrl) throw new Error(`fila ${queueName} sem URL`);
  return QueueUrl;
}
