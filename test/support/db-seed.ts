import type { Client } from "pg";
import { inTransaction, newId } from "./db";

/**
 * Linhas montadas por SQL direto, sem o ORM: os testes de schema tentam
 * violar as garantias no próprio banco (R-05-09). Os valores são strings,
 * como o banco os guarda (D2.4).
 */
export type Row = Record<string, string | number | boolean | Date | null>;

/** Linha de transação com as chaves que os testes leem de volta. */
export type TransactionRow = Row & {
  id: string;
  external_transaction_id: string | null;
  currency: string;
};

/** Overrides de uma `BET` `REJECTED` válida: grava sem lançamento (R-06-43). */
export const rejected: Row = {
  status: "REJECTED",
  failure_code: "INSUFFICIENT_FUNDS",
  processed_at: null,
};

export async function insertRow(
  client: Client,
  table: string,
  row: Row,
): Promise<void> {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  await client.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
    Object.values(row),
  );
}

export interface SeededWallet {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  /** Id da `OPENING`, quando o saldo inicial é positivo. */
  openingTransactionId: string | undefined;
}

export function walletRow(overrides: Row = {}): Row {
  const now = new Date();
  return {
    id: newId(),
    player_id: `player-${newId()}`,
    currency: "BRL",
    balance: "0.00",
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/** Transação `BET` `PROCESSED` válida para a wallet; os testes sobrescrevem o resto. */
export function transactionRow(
  wallet: Pick<SeededWallet, "id" | "playerId" | "currency">,
  overrides: Row = {},
): TransactionRow {
  const now = new Date();
  return {
    id: newId(),
    provider_id: "provider-1",
    external_transaction_id: `ext-${newId()}`,
    idempotency_key: `key-${newId()}`,
    payload_hash: "a".repeat(64),
    wallet_id: wallet.id,
    player_id: wallet.playerId,
    round_id: "round-1",
    game_id: "game-1",
    kind: "BET",
    amount: "10.00",
    currency: wallet.currency,
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: "PROCESSED",
    failure_code: null,
    failure_detail: null,
    balance_after: "0.00",
    balance_after_currency: wallet.currency,
    processed_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  } as TransactionRow;
}

/** Wallet com `OPENING` e lançamento v1 quando o saldo é positivo (D6.2). */
export async function seedWallet(
  client: Client,
  options: { balance?: string; currency?: string; playerId?: string } = {},
): Promise<SeededWallet> {
  const balance = options.balance ?? "0.00";
  const row = walletRow({
    balance,
    currency: options.currency ?? "BRL",
    ...(options.playerId ? { player_id: options.playerId } : {}),
  });
  const wallet: SeededWallet = {
    id: String(row.id),
    playerId: String(row.player_id),
    currency: String(row.currency),
    balance,
    version: 1,
    openingTransactionId: undefined,
  };

  await inTransaction(client, async () => {
    await insertRow(client, "wallets", row);
    if (balance === "0.00") return;
    const openingId = newId();
    await insertRow(
      client,
      "wager_transactions",
      transactionRow(wallet, {
        id: openingId,
        provider_id: null,
        external_transaction_id: null,
        idempotency_key: null,
        payload_hash: null,
        round_id: null,
        game_id: null,
        kind: "OPENING",
        amount: balance,
        balance_after: balance,
      }),
    );
    await insertRow(client, "wallet_ledger_entries", {
      id: newId(),
      wallet_id: wallet.id,
      transaction_id: openingId,
      direction: "CREDIT",
      amount: balance,
      currency: wallet.currency,
      balance_before: "0.00",
      balance_after: balance,
      wallet_version: 1,
      created_at: new Date(),
    });
    wallet.openingTransactionId = openingId;
  });
  return wallet;
}

export interface Movement {
  /** Transação `PROCESSED` já montada (por `transactionRow`). */
  transaction: TransactionRow;
  direction: "DEBIT" | "CREDIT";
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
}

/**
 * Grava transação, lançamento e saldo, sem abrir transação: quem chama
 * controla o BEGIN/COMMIT (o trigger de cauda só confere no commit).
 */
export async function writeMovement(
  client: Client,
  walletId: string,
  movement: Movement,
): Promise<string> {
  await insertRow(client, "wager_transactions", movement.transaction);
  const entryId = newId();
  await insertRow(client, "wallet_ledger_entries", {
    id: entryId,
    wallet_id: walletId,
    transaction_id: movement.transaction.id,
    direction: movement.direction,
    amount: movement.amount,
    currency: movement.transaction.currency,
    balance_before: movement.balanceBefore,
    balance_after: movement.balanceAfter,
    wallet_version: movement.walletVersion,
    created_at: new Date(),
  });
  await client.query(
    "UPDATE wallets SET balance = $2, version = $3, updated_at = now() WHERE id = $1",
    [walletId, movement.balanceAfter, movement.walletVersion],
  );
  return entryId;
}

/**
 * Movimento completo (transação `PROCESSED`, lançamento, saldo e versão)
 * comprometido na hora, a partir do estado atual da wallet (D6.2, D15.9).
 * A direção tem que ser a do kind da transação.
 */
export async function commitMovement(
  client: Client,
  wallet: SeededWallet,
  direction: "DEBIT" | "CREDIT",
  amount: string,
  overrides: Row = {},
): Promise<TransactionRow> {
  const before = wallet.balance;
  const after =
    direction === "DEBIT"
      ? subtractCents(before, amount)
      : addCents(before, amount);
  const transaction = transactionRow(wallet, {
    amount,
    balance_after: after,
    ...overrides,
  });
  await inTransaction(client, () =>
    writeMovement(client, wallet.id, {
      transaction,
      direction,
      amount,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: wallet.version + 1,
    }),
  );
  wallet.balance = after;
  wallet.version += 1;
  return transaction;
}

/** Débito de uma `BET` comprometido na hora, com a próxima versão (D6.2). */
export function debitBet(
  client: Client,
  wallet: SeededWallet,
  amount: string,
  overrides: Row = {},
): Promise<TransactionRow> {
  return commitMovement(client, wallet, "DEBIT", amount, overrides);
}

/** Crédito comprometido na hora: `WIN` por padrão; `REFUND`/`ROLLBACK` pelos overrides. */
export function credit(
  client: Client,
  wallet: SeededWallet,
  amount: string,
  overrides: Row = {},
): Promise<TransactionRow> {
  return commitMovement(client, wallet, "CREDIT", amount, {
    kind: "WIN",
    ...overrides,
  });
}

/** Reversão `PROCESSED` de `reference` (mesma wallet e rodada). */
export function reversalOf(reference: TransactionRow): Row {
  return {
    reference_external_transaction_id: reference.external_transaction_id,
    reference_transaction_id: reference.id,
  };
}

/** Aritmética de teste em centavos `bigint` (D2.4): nunca `number`. */
export function subtractCents(a: string, b: string): string {
  return fromCents(toCents(a) - toCents(b));
}

export function addCents(a: string, b: string): string {
  return fromCents(toCents(a) + toCents(b));
}

function toCents(amount: string): bigint {
  return BigInt(amount.replace(".", ""));
}

function fromCents(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const digits = (cents < 0n ? -cents : cents).toString().padStart(3, "0");
  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
