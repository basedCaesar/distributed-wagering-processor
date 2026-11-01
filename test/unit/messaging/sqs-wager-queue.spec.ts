import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import {
  type QueueMessage,
  type SqsCommand,
  SqsWagerQueue,
} from "../../../src/modules/wagering/infra/messaging/sqs-wager-queue";

const URLS = { queueUrl: "http://sqs/main.fifo", dlqUrl: "http://sqs/dlq.fifo" };

type Sent = { name: string; input: Record<string, unknown> };

/** Cliente SQS em memória: registra cada comando e falha nos que o teste pedir. */
function fakeClient(options: { failOn?: string; receive?: Record<string, unknown>[] } = {}) {
  const sent: Sent[] = [];
  return {
    sent,
    client: {
      async send(command: SqsCommand): Promise<unknown> {
        const name = command.constructor.name;
        sent.push({ name, input: { ...command.input } });
        if (name === options.failOn) throw new Error(`${name} falhou`);
        if (command instanceof ReceiveMessageCommand) return { Messages: options.receive ?? [] };
        return {};
      },
    },
  };
}

const message = (overrides: Partial<QueueMessage> = {}): QueueMessage => ({
  sqsMessageId: "sqs-1",
  receiptHandle: "rh-1",
  body: '{"messageId":"msg-1"}',
  attributes: { origin: { DataType: "String", StringValue: "provider-a" } },
  groupId: "group-1",
  deduplicationId: "dedup-1",
  receiveCount: 1,
  ...overrides,
});

describe("D8.2 D19.6: cópia para a DLQ", () => {
  it("D19.6: envia para a DLQ e só depois apaga da fila", async () => {
    const { client, sent } = fakeClient();
    await new SqsWagerQueue(client, URLS).deadLetter(message());

    expect(sent.map((c) => c.name)).toEqual([SendMessageCommand.name, DeleteMessageCommand.name]);
    expect(sent[1]?.input).toEqual({ QueueUrl: URLS.queueUrl, ReceiptHandle: "rh-1" });
  });

  it("D19.6: se o SendMessage para a DLQ falhar, o DeleteMessage não é chamado", async () => {
    const { client, sent } = fakeClient({ failOn: SendMessageCommand.name });

    await expect(new SqsWagerQueue(client, URLS).deadLetter(message())).rejects.toThrow();
    expect(sent.map((c) => c.name)).toEqual([SendMessageCommand.name]);
  });

  it("D8.2 D19.6: corpo, atributos, grupo e deduplicação intactos, sem atributo novo", async () => {
    const { client, sent } = fakeClient();
    await new SqsWagerQueue(client, URLS).deadLetter(message());

    expect(sent[0]?.input).toEqual({
      QueueUrl: URLS.dlqUrl,
      MessageBody: '{"messageId":"msg-1"}',
      MessageAttributes: { origin: { DataType: "String", StringValue: "provider-a" } },
      MessageGroupId: "group-1",
      MessageDeduplicationId: "dedup-1",
    });
  });

  it("D19.6: sem deduplicação original, usa o SHA-256 do corpo; sem atributos, não manda o campo", async () => {
    const { client, sent } = fakeClient();
    const body = "{ not json";
    await new SqsWagerQueue(client, URLS).deadLetter(
      message({ body, attributes: undefined, deduplicationId: undefined }),
    );

    expect(sent[0]?.input).toEqual({
      QueueUrl: URLS.dlqUrl,
      MessageBody: body,
      MessageGroupId: "group-1",
      MessageDeduplicationId: createHash("sha256").update(body).digest("hex"),
    });
  });
});

describe("D8.2 D19.6: recebimento e visibilidade", () => {
  it("D19.6: receive com long poll, lote e visibilidade dados; lê grupo, deduplicação, contagem e atributos", async () => {
    const { client, sent } = fakeClient({
      receive: [
        {
          MessageId: "sqs-9",
          ReceiptHandle: "rh-9",
          Body: "{}",
          Attributes: {
            MessageGroupId: "g-9",
            MessageDeduplicationId: "d-9",
            ApproximateReceiveCount: "3",
          },
          MessageAttributes: { a: { DataType: "String", StringValue: "1", StringListValues: [], BinaryListValues: [] } },
        },
      ],
    });
    const received = await new SqsWagerQueue(client, URLS).receive({
      maxMessages: 10,
      waitTimeSeconds: 20,
      visibilityTimeoutSeconds: 120,
    });

    expect(sent[0]?.input).toMatchObject({
      QueueUrl: URLS.queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20,
      VisibilityTimeout: 120,
      MessageAttributeNames: ["All"],
    });
    expect(received).toEqual([
      {
        sqsMessageId: "sqs-9",
        receiptHandle: "rh-9",
        body: "{}",
        attributes: { a: { DataType: "String", StringValue: "1" } },
        groupId: "g-9",
        deduplicationId: "d-9",
        receiveCount: 3,
      },
    ]);
  });

  it("D8.2: retry muda a visibilidade da mensagem, sem apagar", async () => {
    const { client, sent } = fakeClient();
    await new SqsWagerQueue(client, URLS).changeVisibility(message(), 8);

    expect(sent).toEqual([
      {
        name: ChangeMessageVisibilityCommand.name,
        input: { QueueUrl: URLS.queueUrl, ReceiptHandle: "rh-1", VisibilityTimeout: 8 },
      },
    ]);
  });
});
