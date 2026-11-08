import type { MikroORM } from "@mikro-orm/postgresql";
import type { Client } from "pg";
import {
  type AccountingReconciliationReport,
  reconcileAccounting,
} from "../../src/modules/accounting/domain/accounting-reconciliation";
import { RecordEventHalfUseCase } from "../../src/modules/accounting/application/record-event-half.use-case";
import type { AccountingUnitOfWork } from "../../src/modules/accounting/application/ports";
import { AccountingConsumer, ACCOUNTING_CONSUMER_NAME } from "../../src/modules/accounting/infra/messaging/accounting-consumer";
import { MikroOrmAccountingMessageAttempts } from "../../src/modules/accounting/infra/persistence/accounting-message-attempts";
import { readAccountingState, readCoreWallets } from "../../src/modules/accounting/infra/persistence/accounting-reconciliation-reader";
import { MikroOrmAccountingUnitOfWork } from "../../src/modules/accounting/infra/persistence/accounting-unit-of-work";
import type { ConsumerPolicy } from "../../src/modules/wagering/infra/messaging/consumer-policy";
import type { MessageOutcome } from "../../src/modules/wagering/infra/messaging/sqs-consumer";
import { SqsWagerQueue } from "../../src/modules/wagering/infra/messaging/sqs-wager-queue";
import { logger } from "../../src/shared/logger/logger";
import { createOrm } from "../../src/shared/orm/create-orm";
import { credentialsFor, newId, withClient } from "./db";
import { testSqsClient } from "./sqs";

export { ACCOUNTING_CONSUMER_NAME };

/** Política dos testes: long poll curto e reentrega imediata (como o auditor, D20.6). */
const TEST_POLICY: Partial<ConsumerPolicy> = { waitTimeSeconds: 2, backoffMaxSeconds: 0 };

export interface TestAccountingConsumer {
  consumer: AccountingConsumer;
  consumerName: string;
  /** Lançamentos gravados por este consumidor (a métrica, contada à parte). */
  posted(): number;
  pollOnce(): Promise<MessageOutcome[]>;
  close(): Promise<void>;
}

/**
 * Consumidor do accounting montado à mão sobre um MikroORM próprio (papel
 * `accounting_app`) e as filas do teste. O `consumerName` é único por
 * teste, salvo quando o teste pede o de produção.
 */
export async function startTestAccountingConsumer(
  queues: { queueUrl: string; dlqUrl: string },
  options: {
    consumerName?: string;
    /** `application_name` das conexões (D21.1): liga a sessão ao consumidor no `pg_locks`. */
    applicationName?: string;
    wrapUow?: (uow: AccountingUnitOfWork) => AccountingUnitOfWork;
  } = {},
): Promise<TestAccountingConsumer> {
  const consumerName = options.consumerName ?? `accounting-test-${Bun.randomUUIDv7()}`;
  const orm: MikroORM = await createOrm({
    credentials: await credentialsFor("accounting"),
    entities: [],
    ...(options.applicationName !== undefined && { applicationName: options.applicationName }),
  });
  const client = testSqsClient();
  let posted = 0;
  const base = new MikroOrmAccountingUnitOfWork(orm);
  const consumer = new AccountingConsumer(
    {
      queue: new SqsWagerQueue(client, queues),
      attempts: new MikroOrmAccountingMessageAttempts(orm),
      logger,
      record: new RecordEventHalfUseCase(options.wrapUow ? options.wrapUow(base) : base, {
        next: () => Bun.randomUUIDv7(),
      }),
      metrics: { countPosted: () => posted++ },
    },
    { ...TEST_POLICY, consumerName },
  );
  return {
    consumer,
    consumerName,
    posted: () => posted,
    pollOnce: () => consumer.pollOnce(),
    async close() {
      await consumer.stop();
      await orm.close();
      client.destroy();
    },
  };
}

interface EnvelopeBase {
  walletId: string;
  transactionId: string;
  eventId?: string;
  occurredAt?: string;
}

function envelope(eventType: string, aggregateId: string, base: EnvelopeBase, data: Record<string, unknown>) {
  const eventId = base.eventId ?? newId();
  const body = JSON.stringify({
    eventId,
    eventType,
    aggregateId,
    correlationId: `corr-${eventId}`,
    occurredAt: base.occurredAt ?? new Date().toISOString(),
    version: 1,
    data,
  });
  return { eventId, body };
}

/** `WalletBalanceChanged` do §11, como o publisher entrega. */
export function balanceChanged(
  options: EnvelopeBase & {
    direction: "DEBIT" | "CREDIT";
    amount: string;
    before: string;
    after: string;
    walletVersion: number;
    currency?: string;
  },
): { eventId: string; body: string } {
  const currency = options.currency ?? "BRL";
  return envelope("WalletBalanceChanged", options.walletId, options, {
    walletId: options.walletId,
    transactionId: options.transactionId,
    direction: options.direction,
    money: { amount: options.amount, currency },
    balanceBefore: { amount: options.before, currency },
    balanceAfter: { amount: options.after, currency },
    walletVersion: options.walletVersion,
  });
}

/** `WagerTransactionProcessed` (D9.4), como o publisher entrega; sem `walletVersion` quando o saldo não mudou. */
export function transactionProcessed(
  options: EnvelopeBase & {
    kind: string;
    amount: string;
    after: string;
    walletVersion?: number;
    currency?: string;
  },
): { eventId: string; body: string } {
  const currency = options.currency ?? "BRL";
  return envelope("WagerTransactionProcessed", options.transactionId, options, {
    transactionId: options.transactionId,
    walletId: options.walletId,
    providerId: options.kind === "OPENING" ? null : "provider-a",
    externalTransactionId: options.kind === "OPENING" ? null : `tx-${options.transactionId}`,
    roundId: null,
    gameId: null,
    kind: options.kind,
    money: { amount: options.amount, currency },
    balanceAfter: { amount: options.after, currency },
    ...(options.walletVersion !== undefined && { walletVersion: options.walletVersion }),
  });
}

/** As duas metades de uma transação que mudou o saldo. */
export function pair(options: {
  walletId: string;
  transactionId?: string;
  kind: string;
  direction: "DEBIT" | "CREDIT";
  amount: string;
  before: string;
  after: string;
  walletVersion: number;
  currency?: string;
}) {
  const transactionId = options.transactionId ?? newId();
  const common = { ...options, transactionId };
  return {
    transactionId,
    balance: balanceChanged(common),
    processed: transactionProcessed(common),
  };
}

export interface JournalLineRow {
  account: string;
  direction: string;
  amount: string;
  currency: string;
}

export interface JournalEntryRow {
  id: string;
  transaction_id: string;
  kind: string;
  wallet_version: number;
  balance_event_id: string;
  processed_event_id: string;
  lines: JournalLineRow[];
}

/** Lançamentos de uma wallet no diário, por versão, com as linhas na ordem. */
export async function journalOf(walletId: string): Promise<JournalEntryRow[]> {
  return withClient("accounting", async (client) => {
    const { rows } = await client.query<JournalEntryRow>(
      `SELECT e.id, e.transaction_id, e.kind, e.wallet_version, e.balance_event_id, e.processed_event_id,
              json_agg(json_build_object('account', a.code, 'direction', l.direction,
                                         'amount', l.amount::text, 'currency', l.currency)
                       ORDER BY l.line_no) AS lines
         FROM accounting.journal_entries e
         JOIN accounting.journal_lines l ON l.entry_id = e.id
         JOIN accounting.accounts a ON a.id = l.account_id
        WHERE e.wallet_id = $1
        GROUP BY e.id
        ORDER BY e.wallet_version`,
      [walletId],
    );
    return rows;
  });
}

/** Saldo da conta `PLAYER_WALLET` (créditos − débitos), ou `undefined` sem conta. */
export async function playerAccountBalance(walletId: string): Promise<string | undefined> {
  return withClient("accounting", async (client) => {
    const { rows } = await client.query<{ balance: string }>(
      `SELECT COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2)::text AS balance
         FROM accounting.accounts a
         LEFT JOIN accounting.journal_lines l ON l.account_id = a.id
        WHERE a.wallet_id = $1
        GROUP BY a.id`,
      [walletId],
    );
    return rows[0]?.balance;
  });
}

export async function accountingInboxRows(consumerName: string, messageId: string): Promise<number> {
  return withClient("accounting", async (client) => {
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM accounting.inbox_messages WHERE consumer_name = $1 AND message_id = $2",
      [consumerName, messageId],
    );
    return rows[0]?.n ?? 0;
  });
}

export async function accountingAttempts(
  consumerName: string,
  messageId: string,
): Promise<{ attempts: number; last_error_code: string | null } | undefined> {
  return withClient("accounting", async (client) => {
    const { rows } = await client.query<{ attempts: number; last_error_code: string | null }>(
      "SELECT attempts, last_error_code FROM accounting.message_attempts WHERE consumer_name = $1 AND message_id = $2",
      [consumerName, messageId],
    );
    return rows[0];
  });
}

export async function receivedHalves(transactionId: string): Promise<string[]> {
  return withClient("accounting", async (client) => {
    const { rows } = await client.query<{ event_type: string }>(
      "SELECT event_type FROM accounting.received_events WHERE transaction_id = $1 ORDER BY event_type",
      [transactionId],
    );
    return rows.map((row) => row.event_type);
  });
}

/** D27.7: a reconciliação das wallets dadas, lendo o accounting antes do núcleo (como o script). */
export async function reconcileWallets(walletIds: readonly string[]): Promise<AccountingReconciliationReport> {
  const accounting = await withClient("accounting", (client: Client) =>
    readAccountingState((sql, params) => client.query(sql, params).then((r) => r.rows), { walletIds }),
  );
  const core = await withClient("app", (client: Client) =>
    readCoreWallets((sql, params) => client.query(sql, params).then((r) => r.rows), { walletIds }),
  );
  return reconcileAccounting({ ...accounting, core });
}
