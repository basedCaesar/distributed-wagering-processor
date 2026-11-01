import { inTransaction, withClient } from "./db";

/**
 * Adulteração por SQL direto, com o papel **dono** (aceite da S3): a única
 * forma de criar a divergência que a reconciliação precisa encontrar (D6.9),
 * porque o banco recusa saldo sem lançamento e `UPDATE` no ledger (D7.3).
 * Os triggers que barram a mudança são desligados só dentro da transação
 * (DDL é transacional; nenhum evento fica pendente para o commit).
 *
 * Sempre restaure com `restore()` antes do `expectLedgerMatchesBalances()`:
 * o invariante confere **todas** as wallets do banco de teste.
 */
export interface Tampering {
  restore(): Promise<void>;
}

async function withTriggersDisabled(
  table: string,
  triggers: string[],
  sql: string,
  params: unknown[],
): Promise<void> {
  await withClient("owner", async (client) => {
    await inTransaction(client, async () => {
      for (const trigger of triggers) {
        await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      }
      const result = await client.query(sql, params);
      if (result.rowCount !== 1) {
        throw new Error(`adulteração afetou ${result.rowCount} linhas`);
      }
      for (const trigger of triggers) {
        await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      }
    });
  });
}

/** Saldo armazenado mudado sem lançamento. */
export async function tamperWalletBalance(
  walletId: string,
  balance: string,
): Promise<Tampering> {
  const original = await withClient("owner", async (client) => {
    const { rows } = await client.query<{ balance: string }>(
      "SELECT balance::text AS balance FROM wallets WHERE id = $1",
      [walletId],
    );
    return rows[0]?.balance;
  });
  if (original === undefined) throw new Error("wallet não existe");
  const set = (value: string) =>
    withTriggersDisabled(
      "wallets",
      ["wallets_ledger_tail"],
      "UPDATE wallets SET balance = $2 WHERE id = $1",
      [walletId, value],
    );
  await set(balance);
  return { restore: () => set(original) };
}

/**
 * Lançamento do meio com outro valor: `amount` e `balance_after` mudam
 * juntos (a aritmética do lançamento continua certa), e o encadeamento com
 * o próximo quebra.
 */
export async function tamperLedgerEntry(
  walletId: string,
  walletVersion: number,
  values: { amount: string; balanceAfter: string },
): Promise<Tampering> {
  const original = await withClient("owner", async (client) => {
    const { rows } = await client.query<{ amount: string; balance_after: string }>(
      `SELECT amount::text AS amount, balance_after::text AS balance_after
         FROM wallet_ledger_entries WHERE wallet_id = $1 AND wallet_version = $2`,
      [walletId, walletVersion],
    );
    return rows[0];
  });
  if (original === undefined) throw new Error("lançamento não existe");
  const set = (amount: string, balanceAfter: string) =>
    withTriggersDisabled(
      "wallet_ledger_entries",
      ["wallet_ledger_entries_append_only"],
      `UPDATE wallet_ledger_entries SET amount = $3, balance_after = $4
        WHERE wallet_id = $1 AND wallet_version = $2`,
      [walletId, walletVersion, amount, balanceAfter],
    );
  await set(values.amount, values.balanceAfter);
  return { restore: () => set(original.amount, original.balance_after) };
}
