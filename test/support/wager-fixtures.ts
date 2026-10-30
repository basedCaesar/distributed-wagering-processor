import { Money } from "../../src/modules/wagering/domain/money";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from "../../src/modules/wagering/domain/wager-transaction";

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
export const usd = (amount: string) => Money.from({ amount, currency: "USD" });

export const T0 = new Date("2026-10-30T12:00:00.000Z");

let sequence = 0;

/** Submissão válida de BET; os testes sobrescrevem só o que importa. */
export function submissionProps(
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  sequence++;
  return {
    id: `tx-${sequence}`,
    providerId: "provider-1",
    externalTransactionId: `ext-${sequence}`,
    idempotencyKey: `key-${sequence}`,
    payloadHash: `hash-${sequence}`,
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: brl("10.00"),
    referenceExternalTransactionId: undefined,
    createdAt: T0,
    ...overrides,
  };
}

export function submit(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create(submissionProps(overrides));
}
