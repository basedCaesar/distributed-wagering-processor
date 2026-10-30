import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { errorMessage, type HealthCheckResult } from "./health.types";
import { withTimeout } from "./with-timeout";

export async function checkSqs(
  aws: { region: string; endpoint: string; queueName: string },
  timeoutMs: number,
): Promise<HealthCheckResult> {
  const client = new SQSClient({
    region: aws.region,
    endpoint: aws.endpoint,
    maxAttempts: 1,
    // LocalStack não valida credenciais; qualquer par estático evita o provider chain da AWS real.
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    requestHandler: new NodeHttpHandler({
      connectionTimeout: timeoutMs,
      requestTimeout: timeoutMs,
    }),
  });

  try {
    await withTimeout(
      (async () => {
        const { QueueUrl } = await client.send(
          new GetQueueUrlCommand({ QueueName: aws.queueName }),
        );
        await client.send(
          new GetQueueAttributesCommand({
            QueueUrl,
            AttributeNames: ["QueueArn"],
          }),
        );
      })(),
      timeoutMs,
      "sqs get queue attributes",
    );
    return { status: "ok" };
  } catch (error) {
    return { status: "error", reason: errorMessage(error) };
  } finally {
    client.destroy();
  }
}
