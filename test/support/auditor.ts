import type { MikroORM } from "@mikro-orm/postgresql";
import { AuditIntegrationEventUseCase } from "../../src/modules/wagering/application/audit-integration-event.use-case";
import type { ConsumerPolicy } from "../../src/modules/wagering/infra/messaging/consumer-policy";
import { EventAuditor } from "../../src/modules/wagering/infra/messaging/event-auditor";
import type { MessageOutcome } from "../../src/modules/wagering/infra/messaging/sqs-consumer";
import { SqsWagerQueue } from "../../src/modules/wagering/infra/messaging/sqs-wager-queue";
import { WAGERING_ENTITIES } from "../../src/modules/wagering/infra/persistence";
import { MikroOrmMessageAttempts } from "../../src/modules/wagering/infra/persistence/message-attempts";
import { MikroOrmUnitOfWork } from "../../src/modules/wagering/infra/persistence/mikro-orm-unit-of-work";
import { logger } from "../../src/shared/logger/logger";
import { createOrm } from "../../src/shared/orm/create-orm";
import { credentialsFor, newId, withClient } from "./db";
import { testSqsClient } from "./sqs";

export interface TestAuditor {
  auditor: EventAuditor;
  consumerName: string;
  /** Quantas vezes o alarme da D20.1 disparou. */
  outOfOrder(): number;
  pollOnce(): Promise<MessageOutcome[]>;
  close(): Promise<void>;
}

/** Política dos testes: long poll curto e reentrega imediata (como o consumidor da S6). */
const TEST_POLICY: Partial<ConsumerPolicy> = { waitTimeSeconds: 2, backoffMaxSeconds: 0 };

/**
 * Auditor montado à mão sobre um MikroORM próprio e as filas do teste
 * (D20.6). O `consumerName` é único por teste: a inbox dele começa vazia.
 */
export async function startTestAuditor(
  queues: { queueUrl: string; dlqUrl: string },
  options: { consumerName?: string } = {},
): Promise<TestAuditor> {
  const consumerName = options.consumerName ?? `auditor-test-${Bun.randomUUIDv7()}`;
  const orm: MikroORM = await createOrm({ credentials: await credentialsFor("app"), entities: WAGERING_ENTITIES });
  const client = testSqsClient();
  let outOfOrder = 0;
  const auditor = new EventAuditor(
    {
      queue: new SqsWagerQueue(client, queues),
      attempts: new MikroOrmMessageAttempts(orm),
      logger,
      audit: new AuditIntegrationEventUseCase(new MikroOrmUnitOfWork(orm)),
      alerts: { countOutOfOrder: () => outOfOrder++ },
    },
    { ...TEST_POLICY, consumerName },
  );
  return {
    auditor,
    consumerName,
    outOfOrder: () => outOfOrder,
    pollOnce: () => auditor.pollOnce(),
    async close() {
      await auditor.stop();
      await orm.close();
      client.destroy();
    },
  };
}

/** Envelope do §11 (texto), como o publisher o entrega. */
export function envelopeJson(options: {
  walletId: string;
  eventType?: string;
  walletVersion?: number;
  eventId?: string;
  data?: Record<string, unknown>;
}): { eventId: string; body: string } {
  const eventId = options.eventId ?? newId();
  const body = JSON.stringify({
    eventId,
    eventType: options.eventType ?? "WalletBalanceChanged",
    aggregateId: options.walletId,
    correlationId: `corr-${eventId}`,
    occurredAt: new Date().toISOString(),
    version: 1,
    data: {
      walletId: options.walletId,
      ...(options.walletVersion !== undefined && { walletVersion: options.walletVersion }),
      ...options.data,
    },
  });
  return { eventId, body };
}

export interface AuditedRow {
  event_id: string;
  event_type: string;
  wallet_version: number | null;
  in_order: boolean | null;
}

/** Linhas de `audited_events` dos eventos dados, em ordem de chegada. */
export async function auditedRows(eventIds: readonly string[]): Promise<AuditedRow[]> {
  return withClient("app", async (client) => {
    const { rows } = await client.query<AuditedRow>(
      `SELECT event_id, event_type, wallet_version, in_order FROM audited_events
        WHERE event_id = ANY($1::uuid[]) ORDER BY arrival`,
      [eventIds],
    );
    return rows;
  });
}
