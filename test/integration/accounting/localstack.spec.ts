import { describe, expect, it } from "bun:test";
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  GetSubscriptionAttributesCommand,
  ListSubscriptionsByTopicCommand,
  ListTopicsCommand,
  SNSClient,
} from "@aws-sdk/client-sns";

const endpoint = process.env.AWS_ENDPOINT ?? "http://localhost:4567";
const region = process.env.AWS_REGION ?? "us-east-1";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const sqs = new SQSClient({ region, endpoint, credentials });
const sns = new SNSClient({ region, endpoint, credentials });

async function attributesOf(queueName: string, names: string[]): Promise<Record<string, string>> {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl, AttributeNames: names as never }),
  );
  return Attributes ?? {};
}

describe("D27.5: filas do accounting criadas pelo init do LocalStack", () => {
  it("D27.5: wagering-events-accounting-dlq.fifo existe e é FIFO", async () => {
    expect((await attributesOf("wagering-events-accounting-dlq.fifo", ["FifoQueue"])).FifoQueue).toBe("true");
  });

  it("D27.5: wagering-events-accounting.fifo é FIFO, com redrive para a DLQ própria e maxReceiveCount=20", async () => {
    const attributes = await attributesOf("wagering-events-accounting.fifo", ["FifoQueue", "RedrivePolicy"]);

    expect(attributes.FifoQueue).toBe("true");
    const redrive = JSON.parse(attributes.RedrivePolicy ?? "{}");
    expect(redrive.maxReceiveCount).toBe("20");
    expect(redrive.deadLetterTargetArn).toContain("wagering-events-accounting-dlq.fifo");
  });

  it("D12.1 D27.5: wagering-events-accounting.fifo está assinada no tópico, por SQS e com RawMessageDelivery", async () => {
    const { Topics } = await sns.send(new ListTopicsCommand({}));
    const topicArn = Topics?.find((topic) => topic.TopicArn?.endsWith(":wagering-events.fifo"))?.TopicArn;
    const { Subscriptions } = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }));
    const subscription = Subscriptions?.find((s) => s.Endpoint?.endsWith(":wagering-events-accounting.fifo"));

    expect(subscription?.Protocol).toBe("sqs");
    const { Attributes } = await sns.send(
      new GetSubscriptionAttributesCommand({ SubscriptionArn: subscription?.SubscriptionArn }),
    );
    expect(Attributes?.RawMessageDelivery).toBe("true");
  });
});
