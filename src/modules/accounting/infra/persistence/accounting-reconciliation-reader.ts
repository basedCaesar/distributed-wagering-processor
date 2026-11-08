import type {
  AccountingWalletState,
  CoreWalletState,
  ReconciliationInput,
  TrialBalanceRow,
} from "../../domain/accounting-reconciliation";

/** Executor de SQL com parâmetros `$n` (o `pg` do script e dos testes). */
export type QueryRows = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

/** Quais wallets: as dadas, as de um prefixo de `playerId`, ou todas. */
export interface WalletFilter {
  walletIds?: readonly string[];
  playerPrefix?: string;
}

const TRIAL_BALANCE_SQL = `
  SELECT currency,
         COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::numeric(30,2)::text AS debits,
         COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::numeric(30,2)::text AS credits
    FROM accounting.journal_lines
   GROUP BY currency
   ORDER BY currency`;

const ACCOUNT_BALANCES_SQL = `
  SELECT a.wallet_id::text AS wallet_id, a.currency,
         COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(30,2)::text AS balance
    FROM accounting.accounts a
    LEFT JOIN accounting.journal_lines l ON l.account_id = a.id
   WHERE a.wallet_id IS NOT NULL AND ($1::uuid[] IS NULL OR a.wallet_id = ANY($1::uuid[]))
   GROUP BY a.id`;

const POSTED_HALVES_SQL = `
  SELECT r.wallet_id::text AS wallet_id, r.wallet_version,
         r.balance_before::text AS balance_before, r.balance_after::text AS balance_after
    FROM accounting.received_events r
    JOIN accounting.journal_entries e ON e.balance_event_id = r.event_id
   WHERE $1::uuid[] IS NULL OR r.wallet_id = ANY($1::uuid[])`;

const INCOMPLETE_PAIRS_SQL = `
  SELECT count(*)::int AS n
    FROM accounting.received_events r
   WHERE ($1::uuid[] IS NULL OR r.wallet_id = ANY($1::uuid[]))
     AND NOT EXISTS (SELECT 1 FROM accounting.journal_entries e WHERE e.transaction_id = r.transaction_id)`;

const CORE_WALLETS_SQL = `
  SELECT id::text AS wallet_id, currency, balance::text AS balance, version
    FROM wallets
   WHERE ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
     AND ($2::text IS NULL OR starts_with(player_id, $2::text))`;

/**
 * O lado do accounting da reconciliação (D27.7), com o `accounting_app`.
 * Lê numa transação `REPEATABLE READ` só de leitura (uma foto só, como a
 * D6.9). Com prefixo de jogador, o filtro de wallets vem do núcleo: quem
 * chama passa os `walletIds` já resolvidos.
 */
export async function readAccountingState(
  query: QueryRows,
  filter: { walletIds?: readonly string[] } = {},
): Promise<Omit<ReconciliationInput, "core">> {
  const walletIds = filter.walletIds === undefined ? null : [...filter.walletIds];
  await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", []);
  try {
    const trialBalance = (await query(TRIAL_BALANCE_SQL, [])) as unknown as TrialBalanceRow[];
    const balances = (await query(ACCOUNT_BALANCES_SQL, [walletIds])) as { wallet_id: string; currency: string; balance: string }[];
    const halves = (await query(POSTED_HALVES_SQL, [walletIds])) as {
      wallet_id: string;
      wallet_version: number;
      balance_before: string;
      balance_after: string;
    }[];
    const [incomplete] = (await query(INCOMPLETE_PAIRS_SQL, [walletIds])) as { n: number }[];

    const accounting = new Map<string, AccountingWalletState>();
    for (const row of balances) {
      accounting.set(row.wallet_id, { walletId: row.wallet_id, currency: row.currency, accountBalance: row.balance, posted: [] });
    }
    for (const row of halves) {
      accounting.get(row.wallet_id)?.posted.push({
        walletVersion: row.wallet_version,
        balanceBefore: row.balance_before,
        balanceAfter: row.balance_after,
      });
    }
    return { trialBalance, accounting: [...accounting.values()], incompletePairs: incomplete?.n ?? 0 };
  } finally {
    await query("COMMIT", []);
  }
}

/** O lado do núcleo (D27.7), com o `wagering_app`, que já lê `wallets`. Lido **depois** do accounting. */
export async function readCoreWallets(query: QueryRows, filter: WalletFilter = {}): Promise<CoreWalletState[]> {
  const rows = (await query(CORE_WALLETS_SQL, [
    filter.walletIds === undefined ? null : [...filter.walletIds],
    filter.playerPrefix ?? null,
  ])) as { wallet_id: string; currency: string; balance: string; version: number }[];
  return rows.map((row) => ({ walletId: row.wallet_id, currency: row.currency, balance: row.balance, version: row.version }));
}
