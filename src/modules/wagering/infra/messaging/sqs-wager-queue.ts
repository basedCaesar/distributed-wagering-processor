import { createHash } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  type MessageAttributeValue,
  ReceiveMessageCommand,
  type ReceiveMessageCommandOutput,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";

export type SqsCommand =
  | ReceiveMessageCommand
  | DeleteMessageCommand
  | ChangeMessageVisibilityCommand
  | SendMessageCommand;

/** O pedaço do `SQSClient` que o consumidor usa; os testes o decoram para injetar falhas. */
export interface SqsSender {
  send(command: SqsCommand): Promise<unknown>;
}

/** Atributo de mensagem como o produtor mandou: tipo e valor. */
export type MessageAttribute = Pick<MessageAttributeValue, "DataType" | "StringValue" | "BinaryValue">;

export interface QueueMessage {
  /** Id do SQS: muda a cada envio, só para log (D3.7). */
  sqsMessageId: string;
  receiptHandle: string;
  body: string;
  attributes: Record<string, MessageAttribute> | undefined;
  groupId: string;
  deduplicationId: string | undefined;
  /** `ApproximateReceiveCount`: só para o atraso quando o banco está fora (D19.3). */
  receiveCount: number;
}

export interface ReceiveOptions {
  maxMessages: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
}

/**
 * A cópia chegou à DLQ, mas o `DeleteMessage` da fila principal falhou
 * (D19.6): a mensagem continua em voo e volta quando a visibilidade vencer.
 * `cause` é o erro do delete.
 */
export class DeadLetterDeleteError extends Error {
  constructor(cause: unknown) {
    super("cópia enviada para a DLQ, mas o delete da fila falhou", { cause });
    this.name = "DeadLetterDeleteError";
  }
}

/**
 * A fila de entrada e a DLQ (R-10-01). Receive, ack, visibilidade e a
 * cópia para a DLQ: **envia e só depois apaga** (D19.6).
 */
export class SqsWagerQueue {
  constructor(
    private readonly client: SqsSender,
    private readonly urls: { queueUrl: string; dlqUrl: string },
  ) {}

  /** Nunca abortado: um receive abortado continua aberto no servidor (D19.9). */
  async receive(options: ReceiveOptions): Promise<QueueMessage[]> {
    const output = (await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.urls.queueUrl,
        MaxNumberOfMessages: options.maxMessages,
        WaitTimeSeconds: options.waitTimeSeconds,
        VisibilityTimeout: options.visibilityTimeoutSeconds,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: [
          "MessageGroupId",
          "MessageDeduplicationId",
          "ApproximateReceiveCount",
        ],
      }),
    )) as ReceiveMessageCommandOutput;
    return (output.Messages ?? []).map(toQueueMessage);
  }

  /** Ack: só depois do commit (R-10-05). */
  async ack(message: QueueMessage): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.urls.queueUrl, ReceiptHandle: message.receiptHandle }),
    );
  }

  /** Backoff (D8.2) ou devolução no `SIGTERM` (0 s, D8.5). */
  async changeVisibility(message: QueueMessage, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.urls.queueUrl,
        ReceiptHandle: message.receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  /**
   * Cópia intacta para a DLQ (D8.2, D19.6): corpo, atributos, grupo e
   * deduplicação originais, nenhum atributo novo. Envia e só depois apaga:
   * uma queda entre os dois deixa uma cópia a mais na DLQ, nunca perde a
   * mensagem. Se o envio falhar, nada é apagado e o erro do envio sobe; se
   * o envio der certo e o delete falhar, sobe `DeadLetterDeleteError`.
   */
  async deadLetter(message: QueueMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.urls.dlqUrl,
        MessageBody: message.body,
        ...(message.attributes !== undefined && { MessageAttributes: message.attributes }),
        MessageGroupId: message.groupId,
        MessageDeduplicationId:
          message.deduplicationId ?? createHash("sha256").update(message.body).digest("hex"),
      }),
    );
    try {
      await this.ack(message);
    } catch (error) {
      throw new DeadLetterDeleteError(error);
    }
  }
}

function toQueueMessage(message: Message): QueueMessage {
  const system = message.Attributes ?? {};
  const attributes = message.MessageAttributes;
  return {
    sqsMessageId: message.MessageId ?? "",
    receiptHandle: message.ReceiptHandle ?? "",
    body: message.Body ?? "",
    attributes:
      attributes === undefined || Object.keys(attributes).length === 0
        ? undefined
        : Object.fromEntries(
            Object.entries(attributes).map(([name, value]) => [name, plainAttribute(value)]),
          ),
    groupId: system.MessageGroupId ?? "",
    deduplicationId: system.MessageDeduplicationId,
    receiveCount: Number(system.ApproximateReceiveCount ?? "1"),
  };
}

/** Sem as listas vazias que o receive acrescenta: o que o produtor mandou. */
function plainAttribute(value: MessageAttributeValue): MessageAttribute {
  return {
    DataType: value.DataType,
    ...(value.StringValue !== undefined && { StringValue: value.StringValue }),
    ...(value.BinaryValue !== undefined && { BinaryValue: value.BinaryValue }),
  };
}
