import { expect } from "bun:test";
import { withClient } from "./db";

interface Divergence {
  wallet_id: string;
  balance: string;
  calculated: string;
  version: number;
  last_version: number;
}

/**
 * R-13-INV D11.4 (versão com banco): para toda wallet, saldo = Σ créditos −
 * Σ débitos do ledger e version = último `wallet_version` (ou 1 sem
 * lançamento, D6.2). Lê com o papel da aplicação, em `REPEATABLE READ`.
 */
export async function expectLedgerMatchesBalances(): Promise<void> {
  const divergences = await withClient("app", async (client) => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const { rows } = await client.query<Divergence>(`
        SELECT w.id AS wallet_id,
               w.balance::text AS balance,
               COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::numeric(20,2)::text AS calculated,
               w.version,
               COALESCE(MAX(e.wallet_version), 1) AS last_version
          FROM wallets w
          LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
         GROUP BY w.id
        HAVING w.balance <> COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)
            OR w.version <> COALESCE(MAX(e.wallet_version), 1)`);
      return rows;
    } finally {
      await client.query("COMMIT");
    }
  });
  expect(divergences).toEqual([]);
}
