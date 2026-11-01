import type { Client } from "pg";
import { type MoneyJson, newPlayerId, type TestApi, type WalletBody } from "./api";
import { connect } from "./db";

/** Resposta da submissão (D5, D14.3). */
export interface SubmissionBody {
  transactionId: string;
  status: "PROCESSED" | "REJECTED" | "PENDING_REFERENCE" | "FAILED";
  failureCode?: string;
  failureDetail?: string;
  balance?: MoneyJson;
  idempotentReplay: boolean;
}

/** `GET` de transação (D5). */
export interface TransactionBody {
  transactionId: string;
  providerId: string | null;
  externalTransactionId: string | null;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: string;
  money: MoneyJson;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: string;
  failureCode?: string;
  failureDetail?: string;
  balance?: MoneyJson;
  createdAt: string;
  processedAt?: string;
}

export interface TestWallet {
  id: string;
  playerId: string;
}

export const brl = (amount: string): MoneyJson => ({ amount, currency: "BRL" });

export const newExternalId = (prefix = "tx"): string => `${prefix}-${Bun.randomUUIDv7()}`;

/** Wallet criada pela API real (operator), com o saldo inicial dado. */
export async function createWallet(
  api: TestApi,
  initialBalance: MoneyJson = brl("100.00"),
): Promise<TestWallet> {
  const response = await api.request("POST", "/wallets", {
    body: { playerId: newPlayerId(), initialBalance },
  });
  if (response.status !== 201) {
    throw new Error(`POST /wallets devolveu ${response.status}`);
  }
  const wallet = (await response.json()) as WalletBody;
  return { id: wallet.id, playerId: wallet.playerId };
}

export type SubmissionInput = Record<string, unknown> & {
  providerId: string;
  externalTransactionId: string;
};

/** Corpo do §9 (L478–488) para a wallet; os testes sobrescrevem o resto. */
export function wagerBody(
  wallet: TestWallet,
  overrides: Record<string, unknown> = {},
): SubmissionInput {
  return {
    providerId: "provider-a",
    externalTransactionId: newExternalId(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: brl("25.00"),
    ...overrides,
  } as SubmissionInput;
}

/**
 * `POST /wagering/transactions` com o token do provedor do corpo e a key
 * recomendada `{providerId}:{externalTransactionId}` (R-09-13), salvo
 * quando o teste passa outra.
 */
export async function submit(
  api: TestApi,
  body: SubmissionInput,
  options: { key?: string | null; token?: string | null; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: SubmissionBody; headers: Headers }> {
  const key =
    options.key === undefined ? `${body.providerId}:${body.externalTransactionId}` : options.key;
  const token =
    options.token === undefined ? await api.issuer.providerToken(body.providerId) : options.token;
  const response = await api.request("POST", "/wagering/transactions", {
    token,
    body,
    headers: { ...(key !== null && { "idempotency-key": key }), ...options.headers },
  });
  return {
    status: response.status,
    body: (await response.json()) as SubmissionBody,
    headers: response.headers,
  };
}

/**
 * Transação crua (papel da app) que trava a wallet com `FOR UPDATE` e não
 * commita: as submissões ficam esperando o lock até o teste soltar.
 */
export async function holdWalletLock(walletId: string): Promise<{
  pid: number;
  release(): Promise<void>;
}> {
  const holder = await connect("app");
  await holder.query("BEGIN");
  await holder.query("SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE", [walletId]);
  const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  let released = false;
  return {
    pid: rows[0]?.pid as number,
    async release() {
      if (released) return;
      released = true;
      await holder.query("ROLLBACK");
      await holder.end();
    },
  };
}

/**
 * Espera, por `pg_locks`, `count` sessões esperando o lock de linha da
 * wallet travada pelo backend `holderPid`. A primeira espera na transação
 * dele; as seguintes, no lock de tupla de `wallets` (CLAUDE.md: estado
 * observável, nunca `sleep`).
 */
export async function waitForWalletLockWaiters(
  observer: Client,
  holderPid: number,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 5000;
  let seen = 0;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ waiters: number }>(
      `SELECT count(DISTINCT waiter.pid)::int AS waiters
         FROM pg_locks waiter
        WHERE NOT waiter.granted
          AND waiter.pid <> $1
          AND (
            (waiter.locktype = 'transactionid' AND waiter.transactionid IN (
               SELECT holder.transactionid FROM pg_locks holder
                WHERE holder.pid = $1 AND holder.locktype = 'transactionid'
                  AND holder.mode = 'ExclusiveLock' AND holder.granted))
            OR (waiter.locktype = 'tuple' AND waiter.relation = 'wallets'::regclass)
          )`,
      [holderPid],
    );
    seen = rows[0]?.waiters ?? 0;
    if (seen >= count) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`esperava ${count} sessões no lock da wallet; vi ${seen} em 5s`);
}
