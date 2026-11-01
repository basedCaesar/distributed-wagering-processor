import { inTransaction, withClient } from "./db";

/**
 * Adulteração por SQL direto, com o papel **dono** (aceite da S3): a única
 * forma de criar a divergência que a reconciliação precisa encontrar (D6.9),
 * porque o banco recusa saldo sem lançamento (D7.3). Só o saldo da wallet é
 * adulterado; o ledger é append-only e nunca recebe `UPDATE`, nem em teste
 * (CLAUDE.md). O `CHAIN_BREAK` é provado no teste de unidade do
 * `reconcileWallet`.
 *
 * O trigger de cauda é desligado só dentro da transação (DDL é
 * transacional; nenhum evento fica pendente para o commit).
 *
 * Sempre restaure com `restore()` antes do `expectLedgerMatchesBalances()`:
 * o invariante confere **todas** as wallets do banco de teste.
 */
export interface Tampering {
  restore(): Promise<void>;
}

async function setBalanceWithoutEntry(
  walletId: string,
  balance: string,
): Promise<void> {
  await withClient("owner", async (client) => {
    await inTransaction(client, async () => {
      await client.query("ALTER TABLE wallets DISABLE TRIGGER wallets_ledger_tail");
      const result = await client.query(
        "UPDATE wallets SET balance = $2 WHERE id = $1",
        [walletId, balance],
      );
      if (result.rowCount !== 1) {
        throw new Error(`adulteração afetou ${result.rowCount} linhas`);
      }
      await client.query("ALTER TABLE wallets ENABLE TRIGGER wallets_ledger_tail");
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
  await setBalanceWithoutEntry(walletId, balance);
  return { restore: () => setBalanceWithoutEntry(walletId, original) };
}
