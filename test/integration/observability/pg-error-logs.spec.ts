import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { WAGERING_ENTITIES } from "../../../src/modules/wagering/infra/persistence";
import { classifyError } from "../../../src/shared/errors/classify-error";
import { logger } from "../../../src/shared/logger/logger";
import { createOrm } from "../../../src/shared/orm/create-orm";
import { startTestApi, type TestApi, type WalletBody } from "../../support/api";
import { startTestConsumer, wagerMessage } from "../../support/consumer";
import { connect, credentialsFor, newId, withClient } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { createTestQueues, sendMessage } from "../../support/sqs";
import { brl, submit, wagerBody } from "../../support/wagering";

/**
 * R-12-02 D22.9 (e): o erro do `pg` traz a linha inteira no `detail`
 * ("Failing row contains (...)"), e o MikroORM põe a query na `message`.
 * Nada disso pode chegar a uma linha de log, em nenhum nível: nem pelo
 * serializer de erro do pino, nem pelo `classifyError()`, nem pelos fluxos
 * HTTP e SQS que caem num `CHECK` violado de verdade.
 */

/** Prazo dos testes que sobem filas e consumidor: o padrão de 5 s do bun não cabe. */
const SLOW_TEST_MS = 30_000;

/** Valor distintivo: não aparece em nenhum outro lugar dos logs. */
const AMOUNT = "4817.53";

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi();
});

afterAll(async () => {
  await api.close();
  await expectLedgerMatchesBalances();
});

function expectNoSecrets(lines: readonly Record<string, unknown>[], secrets: readonly string[]): void {
  const dump = JSON.stringify(lines);
  for (const secret of secrets) expect(dump).not.toContain(secret);
}

/** Um `INSERT` em `wallets` com saldo negativo: viola `wallets_balance_non_negative_ck` de verdade. */
const NEGATIVE_WALLET_SQL =
  "INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES ($1, $2, 'BRL', $3, 1, now(), now())";

async function realPgError(playerId: string): Promise<unknown> {
  return withClient("app", async (client) => {
    try {
      await client.query(NEGATIVE_WALLET_SQL, [newId(), playerId, `-${AMOUNT}`]);
    } catch (error) {
      return error;
    }
    throw new Error("o CHECK de saldo não foi violado");
  });
}

async function realOrmError(playerId: string): Promise<unknown> {
  const orm: MikroORM = await createOrm({ credentials: await credentialsFor("app"), entities: WAGERING_ENTITIES });
  try {
    await orm.em.fork().execute(NEGATIVE_WALLET_SQL.replaceAll(/\$\d/g, "?"), [newId(), playerId, `-${AMOUNT}`]);
  } catch (error) {
    return error;
  } finally {
    await orm.close();
  }
  throw new Error("o CHECK de saldo não foi violado");
}

describe("R-12-02 D22.9: o erro do pg nunca chega ao log", () => {
  it("R-12-02 D22.9: erro real do pg e do MikroORM (CHECK) no logger e no classifyError() → só code, constraint e table", async () => {
    const playerId = `player-pgleak-${newId()}`;
    const pgError = await realPgError(playerId);
    const ormError = await realOrmError(playerId);
    // Pré-condição: os erros carregam mesmo os dados (senão o teste não prova nada).
    expect(JSON.stringify({ detail: (pgError as { detail?: string }).detail })).toContain(playerId);
    expect(String((ormError as Error).message) + String((ormError as { detail?: string }).detail)).toContain(AMOUNT);
    const from = api.logs.length;

    logger.error({ err: pgError }, "s9: erro do pg pelo serializer err");
    logger.warn({ error: ormError }, "s9: erro do MikroORM pelo serializer error");
    logger.error({ failure: classifyError(pgError) }, "s9: erro do pg classificado");
    logger.error({ failure: classifyError(ormError) }, "s9: erro do MikroORM classificado");

    const lines = api.logs.slice(from);
    expect(lines).toHaveLength(4);
    expectNoSecrets(lines, [playerId, AMOUNT]);
    const db = { sqlState: "23514", constraint: "wallets_balance_non_negative_ck", table: "wallets" };
    expect(classifyError(pgError).db).toEqual(db);
    expect(classifyError(ormError).db).toEqual(db);
    expect(lines[0]?.err).toEqual({ type: expect.any(String), code: "23514", constraint: db.constraint, table: "wallets" });
    expect(lines[1]?.error).toEqual({ type: expect.any(String), code: "23514", constraint: db.constraint, table: "wallets" });
  });

  it(
    "R-12-02 D22.9: CHECK violado no fluxo HTTP e no SQS → nenhuma linha com o amount nem o playerId",
    async () => {
      const playerId = `player-pgflow-${newId()}`;
      const created = await api.request("POST", "/wallets", { body: { playerId, initialBalance: brl("9105.38") } });
      expect(created.status).toBe(201);
      const wallet = { id: ((await created.json()) as WalletBody).id, playerId };
      // Um CHECK que só esta wallet viola, com o papel dono; o NOT VALID não relê as linhas já gravadas.
      const constraint = `s9_obs_${newId().replaceAll("-", "_")}_ck`;
      const owner = await connect("owner");
      await owner.query(
        `ALTER TABLE wager_transactions ADD CONSTRAINT ${constraint} CHECK (player_id <> '${playerId}') NOT VALID`,
      );
      const queues = await createTestQueues();
      const consumer = await startTestConsumer(queues);
      const from = api.logs.length;
      try {
        const http = await submit(api, wagerBody(wallet, { money: brl(AMOUNT) }));
        expect(http.status).toBe(500);
        const message = wagerMessage(wallet, { data: { money: brl(AMOUNT) } });
        await sendMessage(queues.queueUrl, message.body, { groupId: wallet.id });
        expect(await consumer.pollOnce()).toEqual(["retry_scheduled"]);

        const lines = api.logs.slice(from);
        // O erro foi logado (com a constraint, para o diagnóstico)...
        expect(lines).toContainEqual(expect.objectContaining({ msg: "requisição falhou", constraint }));
        expect(lines).toContainEqual(expect.objectContaining({ msg: "falha transitória; retry com backoff", constraint }));
        // ...mas nada da linha que o pg recusou.
        expectNoSecrets(lines, [playerId, AMOUNT]);
      } finally {
        await consumer.close();
        await queues.destroy();
        await owner.query(`ALTER TABLE wager_transactions DROP CONSTRAINT ${constraint}`);
        await owner.end();
      }
    },
    SLOW_TEST_MS,
  );
});
