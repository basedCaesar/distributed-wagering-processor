import type { INestApplicationContext } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { Client } from "pg";
import { PendingWorkerAppModule } from "../../src/app/pending-worker.module";
import type { ClaimedPending, UnitOfWork } from "../../src/modules/wagering/application/ports";
import { ResolvePendingTransactionUseCase } from "../../src/modules/wagering/application/resolve-pending-transaction.use-case";
import { WAGERING_ENTITIES } from "../../src/modules/wagering/infra/persistence";
import { MikroOrmUnitOfWork } from "../../src/modules/wagering/infra/persistence/mikro-orm-unit-of-work";
import { MikroOrmPendingQueue } from "../../src/modules/wagering/infra/persistence/pending-queue";
import { PendingWorker } from "../../src/modules/wagering/infra/workers/pending-worker";
import { logger } from "../../src/shared/logger/logger";
import { createOrm } from "../../src/shared/orm/create-orm";
import { credentialsFor, withClient } from "./db";

export interface TestWorker {
  worker: PendingWorker;
  queue: MikroOrmPendingQueue;
  /** Um claim e as tentativas do lote; devolve o que foi pego. */
  runOnce(): Promise<ClaimedPending[]>;
  close(): Promise<void>;
}

/**
 * Worker de pendentes montado à mão sobre um MikroORM **próprio** (pool
 * próprio, papel da app): duas chamadas são duas instâncias (D18.7).
 * `wrapUow` injeta falhas numa tentativa (D18.4) sem trocar o banco.
 */
export async function startTestWorker(
  options: { wrapUow?: (uow: UnitOfWork) => UnitOfWork; batchSize?: number } = {},
): Promise<TestWorker> {
  const orm: MikroORM = await createOrm({
    credentials: await credentialsFor("app"),
    entities: WAGERING_ENTITIES,
  });
  const base = new MikroOrmUnitOfWork(orm);
  const uow = options.wrapUow ? options.wrapUow(base) : base;
  const useCase = new ResolvePendingTransactionUseCase(
    uow,
    { next: () => Bun.randomUUIDv7() },
    { now: () => new Date() },
  );
  const queue = new MikroOrmPendingQueue(orm);
  const worker = new PendingWorker(
    queue,
    useCase,
    logger,
    options.batchSize === undefined ? {} : { batchSize: options.batchSize },
  );
  return {
    worker,
    queue,
    runOnce: () => worker.runOnce(),
    async close() {
      await worker.stop();
      await orm.close();
    },
  };
}

/** O processo `pending-worker` como o entrypoint monta (Nest), com o laço rodando. */
export async function startNestWorker(): Promise<{ close(): Promise<void> }> {
  const moduleRef = await Test.createTestingModule({ imports: [PendingWorkerAppModule] }).compile();
  const app: INestApplicationContext = await moduleRef.init();
  app.get(PendingWorker).start();
  return { close: () => app.close() };
}

/**
 * Roda o worker até `done()` ser verdadeiro (estado observável, sem
 * `sleep`). Outras pendentes no banco podem estar na frente; cada rodada
 * pega um lote.
 */
export async function runWorkerUntil(
  worker: Pick<TestWorker, "runOnce">,
  done: () => Promise<boolean>,
  maxRounds = 50,
): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    if (await done()) return;
    await worker.runOnce();
  }
  if (!(await done())) throw new Error(`condição não atingida em ${maxRounds} rodadas do worker`);
}

export interface PendingRow {
  status: string;
  failure_code: string | null;
  attempts: number;
  consecutive_errors: number;
  next_attempt_at: Date | null;
  locked_until: Date | null;
  created_at: Date;
  balance_after: string | null;
  reference_transaction_id: string | null;
}

export async function pendingRow(id: string): Promise<PendingRow> {
  return withClient("app", async (client) => {
    const { rows } = await client.query<PendingRow>(
      `SELECT status, failure_code, attempts, consecutive_errors, next_attempt_at, locked_until,
              created_at, balance_after::text AS balance_after, reference_transaction_id
         FROM wager_transactions WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new Error(`transação ${id} não existe`);
    return row;
  });
}

/**
 * O banco de teste não é limpo entre arquivos nem entre rodadas
 * (`integration-setup.ts`). Pendentes que um teste deixa vencidas viram
 * backlog do worker nos testes seguintes. Ao fim de cada teste, as que
 * ele criou e ainda estão pendentes vencem só daqui a um dia (só colunas
 * de controle, D4.5).
 */
export async function parkPendings(client: Client, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await client.query(
    `UPDATE wager_transactions SET next_attempt_at = now() + interval '1 day', locked_until = NULL
      WHERE id = ANY($1) AND status = 'PENDING_REFERENCE'`,
    [ids],
  );
  ids.length = 0;
}

/** "O tempo passou": a pendente vence agora (só colunas de controle, D4.5). */
export async function makeDue(client: Client, id: string): Promise<void> {
  await client.query(
    "UPDATE wager_transactions SET next_attempt_at = now(), locked_until = NULL WHERE id = $1",
    [id],
  );
}
