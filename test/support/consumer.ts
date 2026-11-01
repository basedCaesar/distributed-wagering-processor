import type { MikroORM } from "@mikro-orm/postgresql";
import type { DuplicateLayer, UnitOfWork } from "../../src/modules/wagering/application/ports";
import { SubmitWagerTransactionUseCase } from "../../src/modules/wagering/application/submit-wager-transaction.use-case";
import type { ConsumerPolicy } from "../../src/modules/wagering/infra/messaging/consumer-policy";
import { SqsWagerQueue, type SqsSender } from "../../src/modules/wagering/infra/messaging/sqs-wager-queue";
import {
  type MessageOutcome,
  WagerTransactionsConsumer,
} from "../../src/modules/wagering/infra/messaging/wager-transactions-consumer";
import { WAGERING_ENTITIES } from "../../src/modules/wagering/infra/persistence";
import { MikroOrmMessageAttempts } from "../../src/modules/wagering/infra/persistence/message-attempts";
import { MikroOrmUnitOfWork } from "../../src/modules/wagering/infra/persistence/mikro-orm-unit-of-work";
import { logger } from "../../src/shared/logger/logger";
import { createOrm } from "../../src/shared/orm/create-orm";
import type { DatabaseCredentials } from "../../src/shared/secrets/secrets-provider.port";
import { credentialsFor, withClient } from "./db";
import { type TestQueues, testSqsClient } from "./sqs";

export interface TestConsumerOptions {
  /** Padrão: um nome único por consumidor de teste (inbox isolada). */
  consumerName?: string;
  policy?: Partial<ConsumerPolicy>;
  /** Injeta falhas na transação (ex.: commit que falha, R-10-05). */
  wrapUow?: (uow: UnitOfWork) => UnitOfWork;
  /** Injeta falhas no SQS (ex.: morto antes do ack, R-13-C5). */
  wrapSqs?: (client: SqsSender) => SqsSender;
  /** Padrão: o papel da app no banco de teste. */
  credentials?: DatabaseCredentials;
}

export interface TestConsumer {
  consumer: WagerTransactionsConsumer;
  consumerName: string;
  /** Duplicatas contadas pelo use case deste consumidor, por camada (D17.7). */
  counted: DuplicateLayer[];
  /** Um receive e o lote inteiro. */
  pollOnce(): Promise<MessageOutcome[]>;
  close(): Promise<void>;
}

/**
 * Política dos testes: long poll curto (o lote chega na hora, a fila vazia
 * não segura o teste 20 s) e reentrega imediata depois de um retry.
 */
const TEST_POLICY: Partial<ConsumerPolicy> = { waitTimeSeconds: 2, backoffMaxSeconds: 0 };

/**
 * Consumidor montado à mão sobre um MikroORM **próprio** (pool próprio,
 * papel da app) e as filas do teste (D19.8): duas chamadas são duas
 * instâncias (como a D18.7).
 */
export async function startTestConsumer(
  queues: Pick<TestQueues, "queueUrl" | "dlqUrl">,
  options: TestConsumerOptions = {},
): Promise<TestConsumer> {
  const consumerName = options.consumerName ?? `consumer-test-${Bun.randomUUIDv7()}`;
  const orm: MikroORM = await createOrm({
    credentials: options.credentials ?? (await credentialsFor("app")),
    entities: WAGERING_ENTITIES,
  });
  const base = new MikroOrmUnitOfWork(orm);
  const uow = options.wrapUow ? options.wrapUow(base) : base;
  const counted: DuplicateLayer[] = [];
  const useCase = new SubmitWagerTransactionUseCase(
    uow,
    { next: () => Bun.randomUUIDv7() },
    { countDuplicate: (layer) => counted.push(layer) },
  );
  const client = testSqsClient();
  const sender = options.wrapSqs ? options.wrapSqs(client) : client;
  const consumer = new WagerTransactionsConsumer(
    {
      queue: new SqsWagerQueue(sender, queues),
      submit: useCase,
      attempts: new MikroOrmMessageAttempts(orm),
      logger,
      currencies: ["BRL", "USD"],
    },
    { ...TEST_POLICY, consumerName, ...options.policy },
  );
  return {
    consumer,
    consumerName,
    counted,
    pollOnce: () => consumer.pollOnce(),
    async close() {
      await consumer.stop();
      await orm.close();
      client.destroy();
    },
  };
}

/** Faz receives até juntar `count` resultados (estado observável: o long poll). */
export async function pollUntil(
  consumer: Pick<TestConsumer, "pollOnce">,
  count: number,
  maxPolls = 10,
): Promise<MessageOutcome[]> {
  const outcomes: MessageOutcome[] = [];
  for (let poll = 0; poll < maxPolls && outcomes.length < count; poll++) {
    outcomes.push(...(await consumer.pollOnce()));
  }
  if (outcomes.length < count) {
    throw new Error(`esperava ${count} mensagens tratadas, tratei ${outcomes.length} em ${maxPolls} receives`);
  }
  return outcomes;
}

export interface MessageAttemptRow {
  attempts: number;
  last_error_code: string | null;
}

export async function messageAttempts(
  consumerName: string,
  messageId: string,
): Promise<MessageAttemptRow | undefined> {
  return withClient("app", async (client) => {
    const { rows } = await client.query<MessageAttemptRow>(
      "SELECT attempts, last_error_code FROM message_attempts WHERE consumer_name = $1 AND message_id = $2",
      [consumerName, messageId],
    );
    return rows[0];
  });
}

export async function inboxRows(consumerName: string, messageId: string): Promise<number> {
  return withClient("app", async (client) => {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM inbox_messages
        WHERE consumer_name = $1 AND message_id = $2 AND processed_at IS NOT NULL`,
      [consumerName, messageId],
    );
    return rows[0]?.n ?? 0;
  });
}

/** Transações e lançamentos de um id externo do provedor. */
export async function effectsOf(
  providerId: string,
  externalTransactionId: string,
): Promise<{ transactions: { id: string; status: string; failure_code: string | null }[]; entries: { direction: string; amount: string }[] }> {
  return withClient("app", async (client) => {
    const transactions = await client.query(
      `SELECT id, status, failure_code FROM wager_transactions
        WHERE provider_id = $1 AND external_transaction_id = $2`,
      [providerId, externalTransactionId],
    );
    const entries = await client.query(
      `SELECT e.direction, e.amount::text AS amount
         FROM wallet_ledger_entries e
         JOIN wager_transactions t ON t.id = e.transaction_id
        WHERE t.provider_id = $1 AND t.external_transaction_id = $2`,
      [providerId, externalTransactionId],
    );
    return { transactions: transactions.rows, entries: entries.rows };
  });
}

/** Mensagem `WagerTransactionRequested` (§10) para a wallet; o teste sobrescreve o resto. */
export function wagerMessage(
  wallet: { id: string; playerId: string },
  options: { messageId?: string; occurredAt?: string; data?: Record<string, unknown> } = {},
): { messageId: string; externalTransactionId: string; body: string } {
  const externalTransactionId = (options.data?.externalTransactionId as string | undefined) ?? `tx-${Bun.randomUUIDv7()}`;
  const messageId = options.messageId ?? `msg-${Bun.randomUUIDv7()}`;
  const body = JSON.stringify({
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: options.occurredAt ?? "2026-07-29T15:00:00.000Z",
    data: {
      providerId: "provider-a",
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      ...options.data,
    },
  });
  return { messageId, externalTransactionId, body };
}
