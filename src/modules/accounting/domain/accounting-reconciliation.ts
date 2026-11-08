import { Amount } from "./amount";

/** Σ débitos e Σ créditos de todas as linhas do diário numa moeda. */
export interface TrialBalanceRow {
  currency: string;
  debits: string;
  credits: string;
}

/** Uma metade `WalletBalanceChanged` já lançada (D27.1). */
export interface PostedHalf {
  walletVersion: number;
  balanceBefore: string;
  balanceAfter: string;
}

/** A conta `PLAYER_WALLET` de uma wallet no diário. */
export interface AccountingWalletState {
  walletId: string;
  currency: string;
  /** Créditos − débitos das linhas da conta. */
  accountBalance: string;
  posted: PostedHalf[];
}

/** O que o núcleo diz da wallet. */
export interface CoreWalletState {
  walletId: string;
  currency: string;
  balance: string;
  version: number;
}

export interface ReconciliationInput {
  trialBalance: TrialBalanceRow[];
  accounting: AccountingWalletState[];
  core: CoreWalletState[];
  /** Metades sem a outra metade (par ainda sem lançamento). */
  incompletePairs: number;
}

export type WalletReconciliationStatus = "consistent" | "lagging" | "divergent";

export type ReconciliationIssue =
  | "EVENTS_PENDING"
  | "CHAIN_BROKEN"
  | "ACCOUNT_BALANCE_MISMATCH"
  | "CORE_BALANCE_MISMATCH"
  | "VERSION_AHEAD"
  | "WALLET_NOT_IN_CORE"
  | "CURRENCY_MISMATCH";

export interface WalletReconciliation {
  walletId: string;
  status: WalletReconciliationStatus;
  postedVersion: number | null;
  coreVersion: number | null;
  issues: ReconciliationIssue[];
}

export interface AccountingReconciliationReport {
  /** Nenhuma divergência e trial balance zero em toda moeda. */
  consistent: boolean;
  /** Nada atrasado e nenhum par incompleto: o diário alcançou o núcleo. */
  settled: boolean;
  trialBalance: { currency: string; difference: string; balanced: boolean }[];
  wallets: WalletReconciliation[];
  counts: Record<WalletReconciliationStatus, number>;
  incompletePairs: number;
}

/** A primeira versão de uma wallet: 1 com `OPENING`, 2 sem ela (D6.2). As duas partem de 0. */
const FIRST_VERSION_WITHOUT_OPENING = 2;

function reconcileWallet(
  walletId: string,
  account: AccountingWalletState | undefined,
  core: CoreWalletState | undefined,
): WalletReconciliation {
  const posted = [...(account?.posted ?? [])].sort((a, b) => a.walletVersion - b.walletVersion);
  const last = posted[posted.length - 1];
  const postedVersion = last?.walletVersion ?? null;
  const coreVersion = core?.version ?? null;
  const divergent: ReconciliationIssue[] = [];
  let pending = false;

  if (core === undefined) {
    divergent.push("WALLET_NOT_IN_CORE");
  } else if (account !== undefined && account.currency !== core.currency) {
    divergent.push("CURRENCY_MISMATCH");
  } else {
    const currency = core.currency;
    const signed = (value: string) => Amount.parseTotal(value, currency);

    // Continuidade (D6.9): só entre versões seguidas; um buraco é evento ainda não consumido.
    let gaps = false;
    const first = posted[0];
    if (first !== undefined) {
      const startsAtZero = signed(first.balanceBefore).isZero();
      if (first.walletVersion === 1 && !startsAtZero) divergent.push("CHAIN_BROKEN");
      if (first.walletVersion === FIRST_VERSION_WITHOUT_OPENING && !startsAtZero) gaps = true;
      if (first.walletVersion > FIRST_VERSION_WITHOUT_OPENING) gaps = true;
    }
    for (let index = 1; index < posted.length; index++) {
      const previous = posted[index - 1] as PostedHalf;
      const current = posted[index] as PostedHalf;
      if (current.walletVersion !== previous.walletVersion + 1) {
        gaps = true;
      } else if (!signed(current.balanceBefore).equals(signed(previous.balanceAfter))) {
        if (!divergent.includes("CHAIN_BROKEN")) divergent.push("CHAIN_BROKEN");
      }
    }

    if (last !== undefined && !gaps && account !== undefined && !signed(account.accountBalance).equals(signed(last.balanceAfter))) {
      divergent.push("ACCOUNT_BALANCE_MISMATCH");
    }

    if (last === undefined) {
      // Sem lançamento: consistente só para a wallet aberta com saldo zero (D2.3, D27.1).
      pending = core.version > 1 || !signed(core.balance).isZero();
    } else if (last.walletVersion > core.version) {
      divergent.push("VERSION_AHEAD");
    } else if (last.walletVersion < core.version || gaps) {
      pending = true;
    } else if (!signed(last.balanceAfter).equals(signed(core.balance))) {
      divergent.push("CORE_BALANCE_MISMATCH");
    }
  }

  if (divergent.length > 0) return { walletId, status: "divergent", postedVersion, coreVersion, issues: divergent };
  if (pending) return { walletId, status: "lagging", postedVersion, coreVersion, issues: ["EVENTS_PENDING"] };
  return { walletId, status: "consistent", postedVersion, coreVersion, issues: [] };
}

/**
 * Reconciliação do diário (D27.7): só reporta, nunca corrige (D6.9). Por
 * wallet, separa **atrasada** (eventos ainda não consumidos) de
 * **divergente** (o diário contradiz o núcleo ou a si mesmo). No diário
 * inteiro, Σ débitos − Σ créditos = 0 em cada moeda.
 */
export function reconcileAccounting(input: ReconciliationInput): AccountingReconciliationReport {
  const accounts = new Map(input.accounting.map((account) => [account.walletId, account]));
  const core = new Map(input.core.map((wallet) => [wallet.walletId, wallet]));
  const walletIds = [...new Set([...core.keys(), ...accounts.keys()])].sort();
  const wallets = walletIds.map((walletId) => reconcileWallet(walletId, accounts.get(walletId), core.get(walletId)));

  const trialBalance = [...input.trialBalance]
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0))
    .map((row) => {
      const difference = Amount.parseTotal(row.debits, row.currency).minus(Amount.parseTotal(row.credits, row.currency));
      return { currency: row.currency, difference: difference.toString(), balanced: difference.isZero() };
    });

  const counts: Record<WalletReconciliationStatus, number> = { consistent: 0, lagging: 0, divergent: 0 };
  for (const wallet of wallets) counts[wallet.status] += 1;

  return {
    consistent: counts.divergent === 0 && trialBalance.every((row) => row.balanced),
    settled: counts.lagging === 0 && input.incompletePairs === 0,
    trialBalance,
    wallets,
    counts,
    incompletePairs: input.incompletePairs,
  };
}
