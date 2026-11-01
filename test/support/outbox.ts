import {
  CreateTopicCommand,
  DeleteTopicCommand,
  type PublishCommand,
  SNSClient,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Writable } from "node:stream";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { Client } from "pg";
import pino, { type Logger } from "pino";
import { WAGERING_ENTITIES } from "../../src/modules/wagering/infra/persistence";
import { MikroOrmOutboxStore } from "../../src/modules/wagering/infra/persistence/outbox-store";
import type { OutboxPolicy } from "../../src/modules/wagering/infra/outbox/outbox-policy";
import { OutboxPublisher, type PublishRound } from "../../src/modules/wagering/infra/outbox/outbox-publisher";
import { SnsEventPublisher, type SnsSender } from "../../src/modules/wagering/infra/outbox/sns-event-publisher";
import { createSnsClient } from "../../src/shared/aws/sns-client";
import { createOrm } from "../../src/shared/orm/create-orm";
import { credentialsFor, newId, withClient } from "./db";

const region = process.env.AWS_REGION ?? "us-east-1";
const endpoint = process.env.AWS_ENDPOINT ?? "http://localhost:4567";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const sns = new SNSClient({ region, endpoint, credentials });
const sqs = new SQSClient({ region, endpoint, credentials });

export interface TestTopic {
  topicName: string;
  topicArn: string;
  /** Fila FIFO assinante, com `RawMessageDelivery` (o corpo é o envelope). */
  queueUrl: string;
  destroy(): Promise<void>;
}

/** Tópico SNS FIFO e fila assinante só deste teste (D20.6, como a D19.8). */
export async function createTestTopic(): Promise<TestTopic> {
  const name = `wagering-events-test-${Bun.randomUUIDv7()}`;
  const topicName = `${name}.fifo`;
  const { TopicArn } = await sns.send(
    new CreateTopicCommand({ Name: topicName, Attributes: { FifoTopic: "true" } }),
  );
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: `${name}-sub.fifo`, Attributes: { FifoQueue: "true" } }),
  );
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }),
  );
  await sns.send(
    new SubscribeCommand({
      TopicArn,
      Protocol: "sqs",
      Endpoint: Attributes?.QueueArn,
      Attributes: { RawMessageDelivery: "true" },
    }),
  );
  return {
    topicName,
    topicArn: TopicArn as string,
    queueUrl: QueueUrl as string,
    async destroy() {
      await sns.send(new DeleteTopicCommand({ TopicArn }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl }));
    },
  };
}

export interface TestPublisher {
  publisher: OutboxPublisher;
  /** Linhas JSON que este publisher logou (logger próprio, só dele). */
  logs: Record<string, unknown>[];
  runOnce(): Promise<PublishRound>;
  close(): Promise<void>;
}

/** Logger pino que escreve numa lista, para o teste ler o que um publisher logou. */
function capturingLogger(): { logger: Logger; logs: Record<string, unknown>[] } {
  const logs: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n")) {
        if (line.trim() !== "") logs.push(JSON.parse(line));
      }
      done();
    },
  });
  return { logger: pino({ level: "debug" }, sink), logs };
}

/**
 * Publisher montado à mão sobre um MikroORM **próprio** (pool próprio,
 * papel da app) e o tópico do teste: duas chamadas são duas instâncias.
 * `wrapSns` injeta falhas ou conta as publicações (D20.6). Cada publisher
 * tem o próprio logger, lido em `logs`.
 */
export async function startTestPublisher(
  topic: Pick<TestTopic, "topicArn">,
  options: { wrapSns?: (client: SnsSender) => SnsSender; policy?: Partial<OutboxPolicy> } = {},
): Promise<TestPublisher> {
  const orm: MikroORM = await createOrm({ credentials: await credentialsFor("app"), entities: WAGERING_ENTITIES });
  const client = createSnsClient({ region, endpoint }, { requestTimeoutMs: 10_000 });
  const sender = options.wrapSns ? options.wrapSns(client) : client;
  const { logger, logs } = capturingLogger();
  const publisher = new OutboxPublisher(
    new MikroOrmOutboxStore(orm),
    new SnsEventPublisher(sender, topic.topicArn),
    logger,
    { countStalled: () => {} },
    options.policy,
  );
  return {
    publisher,
    logs,
    runOnce: () => publisher.runOnce(),
    async close() {
      await publisher.stop();
      await orm.close();
      client.destroy();
    },
  };
}

/**
 * SNS com portão: a 1ª chamada fica pendurada até o teste mandar `release()`
 * (encaminha ao SNS de verdade e devolve a resposta dele) ou `fail()`.
 * `reached` resolve quando a chamada chega ao portão (estado observável).
 */
export interface SnsGate {
  wrap(client: SnsSender): SnsSender;
  reached: Promise<void>;
  release(): void;
  fail(error: Error): void;
}

export function gatedSns(): SnsGate {
  let signalReached: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  let pending: { release(): void; fail(error: Error): void } | undefined;
  return {
    reached,
    wrap: (client) => ({
      send(command) {
        return new Promise((resolve, reject) => {
          pending = {
            release: () => {
              client.send(command).then(resolve, reject);
            },
            fail: reject,
          };
          signalReached();
        });
      },
    }),
    release: () => pending?.release(),
    fail: (error) => pending?.fail(error),
  };
}

/** Espera o lease do evento vencer no relógio do banco (estado observável, sem `sleep`). */
export async function waitLeaseExpired(id: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const expired = await withClient("app", async (client) => {
      const { rows } = await client.query<{ expired: boolean }>(
        "SELECT locked_until IS NOT NULL AND locked_until <= now() AS expired FROM outbox_messages WHERE id = $1",
        [id],
      );
      return rows[0]?.expired === true;
    });
    if (expired) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`o lease do evento ${id} não venceu em ${timeoutMs} ms`);
}

/** Conta as chamadas a `Publish` por `eventId` (`MessageDeduplicationId`, D20.6). */
export function countingPublishes(counts: Map<string, number>) {
  return (client: SnsSender): SnsSender => ({
    send(command: PublishCommand) {
      const eventId = command.input.MessageDeduplicationId as string;
      counts.set(eventId, (counts.get(eventId) ?? 0) + 1);
      return client.send(command);
    },
  });
}

/**
 * Marca como publicados os eventos já existentes na outbox (D20.8): o
 * acúmulo das outras fatias não entra no lote do publisher do teste.
 */
export async function parkAllOutbox(): Promise<void> {
  await withClient("app", (client) =>
    client.query("UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL"),
  );
}

export interface SeededEvent {
  id: string;
  walletId: string;
  eventType: string;
  walletVersion?: number;
}

/**
 * Grava um evento na outbox com o envelope do §11 (papel da app), como o
 * use case faria. `client` permite gravar dentro de uma transação aberta.
 */
export async function insertOutboxEvent(
  client: Client,
  options: { walletId: string; eventType?: string; walletVersion?: number },
): Promise<SeededEvent> {
  const id = newId();
  const eventType = options.eventType ?? "WalletBalanceChanged";
  const occurredAt = new Date();
  const payload = {
    eventId: id,
    eventType,
    aggregateId: options.walletId,
    correlationId: `corr-${id}`,
    occurredAt: occurredAt.toISOString(),
    version: 1,
    data: {
      walletId: options.walletId,
      ...(options.walletVersion !== undefined && { walletVersion: options.walletVersion }),
    },
  };
  await client.query(
    `INSERT INTO outbox_messages (id, aggregate_id, ordering_key, event_type, payload, occurred_at, next_attempt_at)
     VALUES ($1, $2, $2, $3, $4, $5, $5)`,
    [id, options.walletId, eventType, JSON.stringify(payload), occurredAt],
  );
  return { id, walletId: options.walletId, eventType, ...(options.walletVersion !== undefined && { walletVersion: options.walletVersion }) };
}

export interface OutboxRowState {
  published: boolean;
  attempts: number;
  last_error_code: string | null;
  locked_by: string | null;
  leased: boolean;
  /** `next_attempt_at - now()`, em segundos (negativo = vencido). */
  due_in_seconds: number;
}

export async function outboxRow(id: string): Promise<OutboxRowState> {
  return withClient("app", async (client) => {
    const { rows } = await client.query<OutboxRowState>(
      `SELECT published_at IS NOT NULL AS published, attempts, last_error_code, locked_by,
              locked_until IS NOT NULL AS leased,
              extract(epoch FROM next_attempt_at - now())::float8 AS due_in_seconds
         FROM outbox_messages WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new Error(`evento ${id} não está na outbox`);
    return row;
  });
}

/** Ids da outbox de uma wallet, em ordem de gravação (`position`). */
export async function outboxIdsOf(walletId: string): Promise<string[]> {
  return withClient("app", async (client) => {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM outbox_messages WHERE ordering_key = $1 ORDER BY position",
      [walletId],
    );
    return rows.map((row) => row.id);
  });
}

export async function unpublishedCount(walletIds: readonly string[]): Promise<number> {
  return withClient("app", async (client) => {
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox_messages WHERE ordering_key = ANY($1::uuid[]) AND published_at IS NULL",
      [walletIds],
    );
    return rows[0]?.n ?? 0;
  });
}

export interface ReceivedEnvelope {
  eventId: string;
  eventType: string;
  groupId: string;
  body: Record<string, unknown>;
}

/**
 * Recebe **e apaga** até `count` mensagens da fila assinante, até
 * `timeoutMs` (long poll, sem `sleep`). Apagar é preciso: o FIFO não
 * entrega as seguintes de um grupo enquanto as anteriores estão em voo.
 */
export async function drainEnvelopes(queueUrl: string, count: number, timeoutMs = 5000): Promise<ReceivedEnvelope[]> {
  const deadline = Date.now() + timeoutMs;
  const received: ReceivedEnvelope[] = [];
  while (received.length < count && Date.now() < deadline) {
    const waitSeconds = Math.max(1, Math.min(5, Math.ceil((deadline - Date.now()) / 1000)));
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ["MessageGroupId"],
      }),
    );
    for (const message of Messages ?? []) {
      const body = JSON.parse(message.Body ?? "{}") as Record<string, unknown>;
      received.push({
        eventId: body.eventId as string,
        eventType: body.eventType as string,
        groupId: message.Attributes?.MessageGroupId ?? "",
        body,
      });
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return received;
}

/** Roda rodadas do publisher até `done()` (estado observável, sem `sleep`). */
export async function runPublisherUntil(
  publisher: Pick<TestPublisher, "runOnce">,
  done: () => Promise<boolean>,
  maxRounds = 50,
): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    if (await done()) return;
    await publisher.runOnce();
  }
  if (!(await done())) throw new Error(`condição não atingida em ${maxRounds} rodadas do publisher`);
}
