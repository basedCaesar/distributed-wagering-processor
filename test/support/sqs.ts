import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  type MessageAttributeValue,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

/** Cliente do LocalStack de teste (`.env.test`). */
export function testSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.AWS_ENDPOINT ?? "http://localhost:4567",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

const sqs = testSqsClient();

export interface TestQueues {
  queueUrl: string;
  dlqUrl: string;
  destroy(): Promise<void>;
}

/**
 * Par de filas FIFO só deste teste (D19.8), com os atributos do init do
 * LocalStack: deduplicação por conteúdo e redrive para a DLQ
 * (`maxReceiveCount` 20, D8.3, salvo quando o teste pede outro).
 */
export async function createTestQueues(options: { maxReceiveCount?: number } = {}): Promise<TestQueues> {
  const name = `wager-test-${Bun.randomUUIDv7()}`;
  const dlq = await sqs.send(
    new CreateQueueCommand({ QueueName: `${name}-dlq.fifo`, Attributes: { FifoQueue: "true" } }),
  );
  const dlqUrl = dlq.QueueUrl as string;
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }),
  );
  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: `${name}.fifo`,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "true",
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: Attributes?.QueueArn,
          maxReceiveCount: String(options.maxReceiveCount ?? 20),
        }),
      },
    }),
  );
  const queueUrl = main.QueueUrl as string;
  return {
    queueUrl,
    dlqUrl,
    async destroy() {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    },
  };
}

/**
 * `SendMessage` como o `awslocal sqs send-message` do §10: corpo e
 * `--message-group-id`, nada mais (D8.1), salvo o que o teste pedir.
 */
export async function sendMessage(
  queueUrl: string,
  body: string,
  options: {
    groupId: string;
    deduplicationId?: string;
    attributes?: Record<string, MessageAttributeValue>;
  },
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: options.groupId,
      ...(options.deduplicationId !== undefined && {
        MessageDeduplicationId: options.deduplicationId,
      }),
      ...(options.attributes !== undefined && { MessageAttributes: options.attributes }),
    }),
  );
}

/**
 * Recebe até `count` mensagens com long poll (estado observável, sem
 * `sleep`), sem apagar. Devolve o que chegou até `timeoutMs`.
 */
export async function receiveMessages(
  queueUrl: string,
  count: number,
  timeoutMs = 5000,
): Promise<Message[]> {
  const deadline = Date.now() + timeoutMs;
  const received: Message[] = [];
  while (received.length < count && Date.now() < deadline) {
    const waitSeconds = Math.max(1, Math.min(5, Math.ceil((deadline - Date.now()) / 1000)));
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: Math.min(10, count - received.length),
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: 60,
        MessageAttributeNames: ["All"],
        AttributeNames: ["All"],
      }),
    );
    received.push(...(Messages ?? []));
  }
  return received;
}

/** Visíveis e em voo, pelos atributos aproximados da fila. */
export async function queueCounts(queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return {
    visible: Number(Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

/** Atributo de mensagem dos testes de "atributos intactos" (D8.2). */
export const ORIGIN_ATTRIBUTES: Record<string, MessageAttributeValue> = {
  origin: { DataType: "String", StringValue: "provider-a-gateway" },
  priority: { DataType: "Number", StringValue: "7" },
};

/** Só `DataType` e o valor: o que o produtor mandou (o receive devolve listas vazias a mais). */
export function plainAttributes(
  attributes: Record<string, MessageAttributeValue> | undefined,
): Record<string, { DataType?: string; StringValue?: string }> {
  return Object.fromEntries(
    Object.entries(attributes ?? {}).map(([key, value]) => [
      key,
      { DataType: value.DataType, StringValue: value.StringValue },
    ]),
  );
}
