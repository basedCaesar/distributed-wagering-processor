import { describe, expect, it } from "bun:test";
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  GetSubscriptionAttributesCommand,
  GetTopicAttributesCommand,
  ListSubscriptionsByTopicCommand,
  ListTopicsCommand,
  SNSClient,
} from "@aws-sdk/client-sns";

const endpoint = process.env.AWS_ENDPOINT ?? "http://localhost:4567";
const region = process.env.AWS_REGION ?? "us-east-1";

const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const sqs = new SQSClient({ region, endpoint, credentials });
const sns = new SNSClient({ region, endpoint, credentials });

async function findTopicArn(): Promise<string> {
  const { Topics } = await sns.send(new ListTopicsCommand({}));
  const topic = Topics?.find((t) =>
    t.TopicArn?.endsWith(":wagering-events.fifo"),
  );
  if (!topic?.TopicArn) {
    throw new Error("tópico wagering-events.fifo não encontrado");
  }
  return topic.TopicArn;
}

describe("S0 D8.1 D8.3 D9.1: infraestrutura AWS criada pelo init do LocalStack", () => {
  it("D8.1: wager-transactions-dlq.fifo existe e é FIFO", async () => {
    const { QueueUrl } = await sqs.send(
      new GetQueueUrlCommand({ QueueName: "wager-transactions-dlq.fifo" }),
    );
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: ["FifoQueue"],
      }),
    );

    expect(Attributes?.FifoQueue).toBe("true");
  });

  it("D8.1 D8.3: wager-transactions.fifo tem deduplicação por conteúdo e redrive para a DLQ com maxReceiveCount=20", async () => {
    const { QueueUrl } = await sqs.send(
      new GetQueueUrlCommand({ QueueName: "wager-transactions.fifo" }),
    );
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: [
          "FifoQueue",
          "ContentBasedDeduplication",
          "RedrivePolicy",
        ],
      }),
    );

    expect(Attributes?.FifoQueue).toBe("true");
    expect(Attributes?.ContentBasedDeduplication).toBe("true");

    const redrivePolicy = JSON.parse(Attributes?.RedrivePolicy ?? "{}");
    expect(redrivePolicy.maxReceiveCount).toBe("20");
    expect(redrivePolicy.deadLetterTargetArn).toContain(
      "wager-transactions-dlq.fifo",
    );
  });

  it("D9.1: o tópico SNS wagering-events.fifo existe e é FIFO", async () => {
    const topicArn = await findTopicArn();
    const { Attributes } = await sns.send(
      new GetTopicAttributesCommand({ TopicArn: topicArn }),
    );

    expect(Attributes?.FifoTopic).toBe("true");
  });

  it("D9.1 D9.7: wagering-events-auditor.fifo está assinada no tópico, por SQS e com RawMessageDelivery", async () => {
    const topicArn = await findTopicArn();
    const { Subscriptions } = await sns.send(
      new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }),
    );
    const subscription = Subscriptions?.find((s) =>
      s.Endpoint?.endsWith(":wagering-events-auditor.fifo"),
    );

    expect(subscription).toBeDefined();
    expect(subscription?.Protocol).toBe("sqs");

    const { Attributes } = await sns.send(
      new GetSubscriptionAttributesCommand({
        SubscriptionArn: subscription?.SubscriptionArn,
      }),
    );
    expect(Attributes?.RawMessageDelivery).toBe("true");
  });
});
