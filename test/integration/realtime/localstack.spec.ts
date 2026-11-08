import { describe, expect, it } from "bun:test";
import {
  GetSubscriptionAttributesCommand,
  ListSubscriptionsByTopicCommand,
  ListTopicsCommand,
  SNSClient,
} from "@aws-sdk/client-sns";
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";

const endpoint = process.env.AWS_ENDPOINT ?? "http://localhost:4567";
const region = process.env.AWS_REGION ?? "us-east-1";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const sqs = new SQSClient({ region, endpoint, credentials });
const sns = new SNSClient({ region, endpoint, credentials });

const INSTANCES = ["realtime-1", "realtime-2"];

async function attributesOf(queueName: string, names: string[]): Promise<Record<string, string>> {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: names as never }));
  return Attributes ?? {};
}

describe("D28.5: filas do realtime criadas pelo init do LocalStack", () => {
  it.each(INSTANCES)("D28.5 D28.7: a fila de %s é FIFO, com retenção de 300 s, visibilidade de 30 s e sem DLQ", async (instance) => {
    const attributes = await attributesOf(`wagering-events-realtime-${instance}.fifo`, [
      "FifoQueue",
      "MessageRetentionPeriod",
      "VisibilityTimeout",
      "RedrivePolicy",
    ]);

    expect(attributes).toMatchObject({ FifoQueue: "true", MessageRetentionPeriod: "300", VisibilityTimeout: "30" });
    expect(attributes.RedrivePolicy).toBeUndefined();
  });

  it.each(INSTANCES)("D28.5 D12.4: a fila de %s está assinada no tópico, por SQS e com RawMessageDelivery", async (instance) => {
    const { Topics } = await sns.send(new ListTopicsCommand({}));
    const topicArn = Topics?.find((topic) => topic.TopicArn?.endsWith(":wagering-events.fifo"))?.TopicArn;
    const { Subscriptions } = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }));
    const subscription = Subscriptions?.find((s) => s.Endpoint?.endsWith(`:wagering-events-realtime-${instance}.fifo`));

    expect(subscription?.Protocol).toBe("sqs");
    const { Attributes } = await sns.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: subscription?.SubscriptionArn }));
    expect(Attributes?.RawMessageDelivery).toBe("true");
  });
});
