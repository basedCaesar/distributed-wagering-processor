import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import {
  type ExampleWallet,
  SeedExampleWalletMismatchError,
  seedExampleWallet,
} from "../../../scripts/seed/example-wallet";
import { OpenWalletUseCase } from "../../../src/modules/wagering/application/open-wallet.use-case";
import { Money } from "../../../src/modules/wagering/domain/money";
import { WAGERING_ENTITIES } from "../../../src/modules/wagering/infra/persistence";
import { MikroOrmUnitOfWork } from "../../../src/modules/wagering/infra/persistence/mikro-orm-unit-of-work";
import { classifyError } from "../../../src/shared/errors/classify-error";
import { createOrm } from "../../../src/shared/orm/create-orm";
import { credentialsFor, withClient } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";

/**
 * Seed do Compose de dev (D23.1) contra o banco de teste, com o papel da app.
 * O banco de teste não é limpo entre rodadas, então cada caso usa ids novos
 * no lugar dos do exemplo; a lógica é a mesma do `scripts/seed-examples.ts`.
 */

let orm: MikroORM;

function freshExample(): ExampleWallet {
  return { walletId: Bun.randomUUIDv7(), playerId: `seed-${Bun.randomUUIDv7()}` };
}

beforeAll(async () => {
  orm = await createOrm({ credentials: await credentialsFor("app"), entities: WAGERING_ENTITIES });
});

afterEach(async () => {
  await expectLedgerMatchesBalances();
});

afterAll(async () => {
  await orm?.close();
});

describe("D23.1: seed da wallet do exemplo", () => {
  it("D23.1 D6.2 D9.4: cria a wallet com o id do exemplo, a OPENING, o lançamento CREDIT e a outbox", async () => {
    const example = freshExample();
    expect(await seedExampleWallet(orm, example)).toBe("created");

    await withClient("app", async (client) => {
      const wallet = await client.query(
        "SELECT player_id, balance::text AS balance, currency, version FROM wallets WHERE id = $1",
        [example.walletId],
      );
      expect(wallet.rows).toEqual([{ player_id: example.playerId, balance: "1000.00", currency: "BRL", version: 1 }]);

      const opening = await client.query(
        "SELECT id, status, amount::text AS amount FROM wager_transactions WHERE wallet_id = $1",
        [example.walletId],
      );
      expect(opening.rows.map((r) => ({ status: r.status, amount: r.amount }))).toEqual([
        { status: "PROCESSED", amount: "1000.00" },
      ]);
      const kinds = await client.query("SELECT kind FROM wager_transactions WHERE wallet_id = $1", [example.walletId]);
      expect(kinds.rows).toEqual([{ kind: "OPENING" }]);

      const ledger = await client.query(
        "SELECT transaction_id, direction, amount::text AS amount FROM wallet_ledger_entries WHERE wallet_id = $1",
        [example.walletId],
      );
      expect(ledger.rows).toEqual([{ transaction_id: opening.rows[0].id, direction: "CREDIT", amount: "1000.00" }]);

      const outbox = await client.query(
        "SELECT event_type FROM outbox_messages WHERE ordering_key = $1 ORDER BY position",
        [example.walletId],
      );
      expect(outbox.rows.map((r) => r.event_type)).toEqual([
        "WalletOpened",
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
      ]);
    });
  });

  it("D23.1: rodar de novo com a wallet do exemplo já criada não faz nada", async () => {
    const example = freshExample();
    expect(await seedExampleWallet(orm, example)).toBe("created");
    const count = (): Promise<unknown> =>
      withClient("app", async (client) => {
        const result = await client.query(
          `SELECT (SELECT count(*) FROM wager_transactions WHERE wallet_id = $1)::int AS transactions,
                  (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1)::int AS entries,
                  (SELECT count(*) FROM outbox_messages WHERE ordering_key = $1)::int AS events`,
          [example.walletId],
        );
        return result.rows[0];
      });
    const before = await count();

    expect(await seedExampleWallet(orm, example)).toBe("already-exists");
    expect(await count()).toEqual(before);
  });

  it("D23.1: wallet desse player com outro id → SEED_EXAMPLE_WALLET_MISMATCH, mantido pelo classifyError", async () => {
    const example = freshExample();
    // Wallet do player criada antes pelo caminho normal (POST /wallets): id UUIDv7 aleatório.
    const other = await new OpenWalletUseCase(new MikroOrmUnitOfWork(orm), {
      next: () => Bun.randomUUIDv7(),
    }).execute(
      { playerId: example.playerId, initialBalance: Money.from({ amount: "10.00", currency: "BRL" }) },
      { correlationId: "seed-test", causationId: Bun.randomUUIDv7() },
    );
    expect(other.id).not.toBe(example.walletId);

    let caught: unknown;
    try {
      await seedExampleWallet(orm, example);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SeedExampleWalletMismatchError);
    const classified = classifyError(caught);
    expect(classified.code).toBe("SEED_EXAMPLE_WALLET_MISMATCH");
    expect(classified.message).toContain(other.id);
    expect(classified.message).toContain("infra:down -v");
    expect(classified.message).not.toContain(example.playerId);

    await withClient("app", async (client) => {
      const created = await client.query("SELECT 1 FROM wallets WHERE id = $1", [example.walletId]);
      expect(created.rowCount).toBe(0);
    });
  });
});
