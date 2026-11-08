import { InvalidPostingError } from "./accounting-error";
import type { Amount } from "./amount";
import { AccountCode } from "./chart-of-accounts";

/** A direção de uma linha; na conta da wallet, é a do `WalletBalanceChanged` (D27.2). */
export type LineDirection = "DEBIT" | "CREDIT";

export interface JournalLine {
  readonly lineNo: number;
  readonly account: AccountCode;
  readonly direction: LineDirection;
  readonly amount: Amount;
}

export interface PostJournalEntryProps {
  id: string;
  transactionId: string;
  walletId: string;
  walletVersion: number;
  /** O `kind` do `WagerTransactionProcessed`. */
  kind: string;
  /** A direção do `WalletBalanceChanged`. */
  walletDirection: LineDirection;
  amount: Amount;
}

/** A conta da casa de cada `kind` e direção na wallet (D27.2). */
const HOUSE_ACCOUNT: Readonly<Record<string, Partial<Record<LineDirection, AccountCode>>>> = Object.freeze({
  OPENING: { CREDIT: AccountCode.HouseOpeningFunds },
  BET: { DEBIT: AccountCode.HouseWagersReceived },
  WIN: { CREDIT: AccountCode.HousePayouts },
  REFUND: { CREDIT: AccountCode.HouseRefunds },
  ROLLBACK: { CREDIT: AccountCode.HouseRollbacks, DEBIT: AccountCode.HouseRollbacks },
});

const opposite = (direction: LineDirection): LineDirection => (direction === "DEBIT" ? "CREDIT" : "DEBIT");

/**
 * Lançamento de partidas dobradas (§6.4 L313, D27.2): imutável, congelado
 * na construção, sem transições. Sempre 2 linhas na mesma moeda: a conta
 * da wallet, na direção do saldo, e a conta da casa do `kind`, na oposta.
 * A linha de débito vem primeiro.
 */
export class JournalEntry {
  private constructor(
    readonly id: string,
    readonly transactionId: string,
    readonly walletId: string,
    readonly walletVersion: number,
    readonly kind: string,
    readonly lines: readonly JournalLine[],
  ) {
    Object.freeze(this);
  }

  static post(props: PostJournalEntryProps): JournalEntry {
    const house = HOUSE_ACCOUNT[props.kind]?.[props.walletDirection];
    if (house === undefined) {
      throw new InvalidPostingError(`${props.kind} com ${props.walletDirection} na wallet não tem lançamento`);
    }
    if (!props.amount.isPositive()) throw new InvalidPostingError("lançamento sem valor");
    if (!(props.walletVersion >= 1) || props.walletVersion % 1 !== 0) {
      throw new InvalidPostingError("versão da wallet inválida");
    }
    const sides: [AccountCode, LineDirection][] = [
      [AccountCode.PlayerWallet, props.walletDirection],
      [house, opposite(props.walletDirection)],
    ];
    sides.sort(([, a], [, b]) => (a === b ? 0 : a === "DEBIT" ? -1 : 1));
    const lines = Object.freeze(
      sides.map(([account, direction], index) =>
        Object.freeze({ lineNo: index + 1, account, direction, amount: props.amount }),
      ),
    );
    const entry = new JournalEntry(props.id, props.transactionId, props.walletId, props.walletVersion, props.kind, lines);
    if (!entry.isBalanced()) throw new InvalidPostingError("lançamento desbalanceado");
    return entry;
  }

  get currency(): string {
    return (this.lines[0] as JournalLine).amount.currency;
  }

  /** Σ débitos = Σ créditos, numa moeda só, com ≥ 2 linhas (o banco confere de novo, D27.3). */
  isBalanced(): boolean {
    if (this.lines.length < 2) return false;
    const currency = this.currency;
    if (this.lines.some((line) => line.amount.currency !== currency)) return false;
    let difference = 0n;
    for (const line of this.lines) {
      difference += line.direction === "DEBIT" ? line.amount.cents : -line.amount.cents;
    }
    return difference === 0n;
  }
}
