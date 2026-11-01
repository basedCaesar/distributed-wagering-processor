import type { Client } from "pg";
import { type MoneyJson, newPlayerId, type TestApi, type WalletBody } from "./api";
import { connect, withClient } from "./db";

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

export interface WalletLock {
  pid: number;
  walletId: string;
  release(): Promise<void>;
}

/**
 * Transação crua (papel da app) que trava a wallet com `FOR UPDATE` e não
 * commita: as submissões ficam esperando o lock até o teste soltar. Ela
 * trava só essa linha, então quem espera o `transactionid` dela espera
 * essa wallet.
 */
export async function holdWalletLock(walletId: string): Promise<WalletLock> {
  const holder = await connect("app");
  await holder.query("BEGIN");
  await holder.query("SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE", [walletId]);
  const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  let released = false;
  return {
    pid: rows[0]?.pid as number,
    walletId,
    async release() {
      if (released) return;
      released = true;
      await holder.query("ROLLBACK");
      await holder.end();
    },
  };
}

/**
 * Início da transação (`xact_start`, o que o `now()` dela devolve) das
 * sessões bloqueadas **diretamente** pela sessão `holderPid`. Serve para
 * provar que o horário gravado é o `now()` da transação no banco (D18.12).
 */
export async function transactionStartsBlockedBy(
  observer: Client,
  holderPid: number,
): Promise<Date[]> {
  const { rows } = await observer.query<{ xact_start: Date }>(
    `SELECT xact_start FROM pg_stat_activity
      WHERE $1 = ANY(pg_blocking_pids(pid)) AND xact_start IS NOT NULL`,
    [holderPid],
  );
  return rows.map((row) => row.xact_start);
}

/**
 * Prazo da espera pelos waiters: abaixo do `lock_timeout` de 2 s (D5), para
 * o primeiro waiter não desistir com `503` antes de o teste soltar o lock.
 */
export const WAITERS_DEADLINE_MS = 1500;

/**
 * Espera, por `pg_locks`, `count` sessões esperando o lock da wallet
 * travada por `lock`. A primeira espera no `transactionid` do dono; as
 * seguintes, no lock de tupla **dessa** linha (página e tupla do `ctid`).
 * Waiters de outras wallets não contam (CLAUDE.md: estado observável,
 * nunca `sleep`). Não encheu em 1,5 s → erro com o que viu.
 */
export async function waitForWalletLockWaiters(
  observer: Client,
  lock: Pick<WalletLock, "pid" | "walletId">,
  count: number,
): Promise<void> {
  const deadline = Date.now() + WAITERS_DEADLINE_MS;
  let seen = 0;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ waiters: number }>(
      `WITH target AS (
         SELECT (ctid::text::point)[0]::int AS page, (ctid::text::point)[1]::int AS tuple
           FROM wallets WHERE id = $2
       )
       SELECT count(DISTINCT waiter.pid)::int AS waiters
         FROM pg_locks waiter, target
        WHERE NOT waiter.granted
          AND waiter.pid <> $1
          AND (
            (waiter.locktype = 'transactionid' AND waiter.transactionid IN (
               SELECT holder.transactionid FROM pg_locks holder
                WHERE holder.pid = $1 AND holder.locktype = 'transactionid'
                  AND holder.mode = 'ExclusiveLock' AND holder.granted))
            OR (waiter.locktype = 'tuple'
                AND waiter.relation = 'wallets'::regclass
                AND waiter.page = target.page
                AND waiter.tuple = target.tuple)
          )`,
      [lock.pid, lock.walletId],
    );
    seen = rows[0]?.waiters ?? 0;
    if (seen >= count) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `esperava ${count} sessões no lock da wallet ${lock.walletId}, vi ${seen} em ${WAITERS_DEADLINE_MS} ms ` +
      "(o prazo fica abaixo do lock_timeout de 2 s; se não encheu, as requisições não chegaram ao lock a tempo)",
  );
}

export interface OutboxEventRow {
  event_type: string;
  aggregate_id: string;
  ordering_key: string;
  payload: { correlationId?: string; data: Record<string, unknown> };
}

/**
 * Eventos da wallet depois da abertura, em ordem de gravação (D9.2): sem
 * `WalletOpened`, sem os eventos da `OPENING` e sem o `WalletBalanceChanged`
 * da versão 1.
 */
export async function eventsAfterOpening(
  walletId: string,
): Promise<OutboxEventRow[]> {
  return withClient("app", async (client) => {
    const { rows } = await client.query(
      `SELECT event_type, aggregate_id, ordering_key, payload
         FROM outbox_messages
        WHERE ordering_key = $1
          AND aggregate_id NOT IN (SELECT id FROM wager_transactions WHERE wallet_id = $1 AND kind = 'OPENING')
          AND event_type <> 'WalletOpened'
          AND NOT (event_type = 'WalletBalanceChanged' AND (payload->'data'->>'walletVersion')::int = 1)
        ORDER BY position`,
      [walletId],
    );
    return rows;
  });
}
