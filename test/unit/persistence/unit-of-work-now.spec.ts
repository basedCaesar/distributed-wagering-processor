import { describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { MikroOrmUnitOfWork } from "../../../src/modules/wagering/infra/persistence/mikro-orm-unit-of-work";

/**
 * `EntityManager` falso: só o `execute`, que conta os `SELECT now()` e
 * aceita o `INSERT` da inbox. Cada `transactional` é uma transação nova.
 */
function fakeOrm() {
  let nowReads = 0;
  const em = {
    async execute(sql: string) {
      if (sql.includes("AS now")) {
        nowReads++;
        return [{ now: "2026-11-03T12:00:00.000Z" }];
      }
      if (sql.includes("INSERT INTO inbox_messages")) return [{ message_id: "m" }];
      throw new Error(`SQL inesperado no teste: ${sql}`);
    },
  };
  const orm = {
    em: {
      fork: () => ({
        transactional: <T>(work: (transactionEm: typeof em) => Promise<T>) => work(em),
      }),
    },
  } as unknown as MikroORM;
  return { uow: new MikroOrmUnitOfWork(orm), nowReads: () => nowReads };
}

describe("D24.5 D18.12: now() da transação", () => {
  it("D24.5: várias chamadas de now(), em sequência, em paralelo e pela inbox → um só SELECT now() por transação, sempre o mesmo valor", async () => {
    const { uow, nowReads } = fakeOrm();

    const seen = await uow.run(async (scope) => {
      const first = await scope.now();
      const parallel = await Promise.all([scope.now(), scope.now(), scope.now()]);
      await scope.inbox.register({ consumerName: "c", messageId: "m", hash: "h" });
      const last = await scope.now();
      return [first, ...parallel, last];
    });

    expect(nowReads()).toBe(1);
    expect(new Set(seen.map((date) => date.getTime())).size).toBe(1);
  });

  it("D24.5: o valor é por transação, não do processo: duas transações → dois SELECT now()", async () => {
    const { uow, nowReads } = fakeOrm();

    await uow.run(async (scope) => scope.now());
    await uow.run(async (scope) => scope.now());

    expect(nowReads()).toBe(2);
  });
});
