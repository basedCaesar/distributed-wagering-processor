import { describe, expect, it } from "bun:test";
import {
  ConcurrentSubmissionError,
  DuplicateTransactionError,
} from "../../../src/modules/wagering/application/errors";
import { payloadHash } from "../../../src/modules/wagering/application/payload-hash";
import type {
  DuplicateLayer,
  TransactionScope,
  UnitOfWork,
} from "../../../src/modules/wagering/application/ports";
import {
  type SubmitWagerTransactionCommand,
  SubmitWagerTransactionUseCase,
} from "../../../src/modules/wagering/application/submit-wager-transaction.use-case";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../../../src/modules/wagering/domain/wager-transaction";
import { Wallet } from "../../../src/modules/wagering/domain/wallet";
import { TransientError } from "../../../src/shared/errors/app-errors";
import { brl, T0 } from "../../support/wager-fixtures";

const wallet = () =>
  Wallet.rehydrate({
    id: "0192f291-27dd-7d3f-8071-5f8685deef37",
    playerId: "player-1",
    currency: "BRL",
    balance: brl("100.00"),
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  });

const command: SubmitWagerTransactionCommand = {
  idempotencyKey: "provider-a:tx-1",
  providerId: "provider-a",
  externalTransactionId: "tx-1",
  playerId: "player-1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-1",
  gameId: "game-1",
  kind: WagerTransactionKind.Bet,
  money: brl("10.00"),
  referenceExternalTransactionId: undefined,
};

/** A transação que "ganhou" fora do lock desta wallet, com o mesmo payload. */
function winner(): WagerTransaction {
  return WagerTransaction.create({
    id: "0192f298-345e-7e38-af88-e43f851a819d",
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    idempotencyKey: command.idempotencyKey,
    payloadHash: payloadHash(command),
    walletId: command.walletId,
    playerId: command.playerId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money,
    referenceExternalTransactionId: undefined,
    createdAt: T0,
  });
}

/**
 * `UnitOfWork` em memória: a 1ª chamada é a checagem rápida; nas
 * seguintes, o "commit" falha com `DuplicateTransactionError` enquanto
 * houver `commitFailures`. Depois da 1ª falha, a vencedora fica visível
 * se `winnerAfterFailure`.
 */
function fakeUow(options: { commitFailures: number; winnerAfterFailure: boolean }) {
  let failuresLeft = options.commitFailures;
  let visible: WagerTransaction | undefined;
  const calls = { runs: 0 };
  const scope = {
    wallets: { lockById: async () => wallet(), update: () => {} },
    transactions: {
      findByProviderAndKey: async () => visible,
      findByProviderAndExternalId: async () => undefined,
      insert: () => {},
    },
    ledger: { insert: () => {} },
    outbox: { append: () => {} },
  } as unknown as TransactionScope;
  const uow: UnitOfWork = {
    async run(work) {
      calls.runs += 1;
      const result = await work(scope);
      if (calls.runs > 1 && failuresLeft > 0) {
        failuresLeft -= 1;
        if (options.winnerAfterFailure) visible = winner();
        throw new DuplicateTransactionError("wager_transactions_provider_key_uq");
      }
      return result;
    },
  };
  return { uow, calls };
}

function useCaseWith(uow: UnitOfWork) {
  const counted: DuplicateLayer[] = [];
  let sequence = 0;
  const useCase = new SubmitWagerTransactionUseCase(
    uow,
    { next: () => `0192f2a0-0000-7000-8000-${String(++sequence).padStart(12, "0")}` },
    { now: () => T0 },
    { countDuplicate: (layer) => counted.push(layer) },
  );
  return { useCase, counted };
}

const meta = { correlationId: "corr-1", causationId: "req-1" };

describe("D3.6 D17.6: barreira do UNIQUE na submissão", () => {
  it("D3.6 D17.7: o UNIQUE barra o commit, a repetição vê a vencedora → replay, contado uma vez em unique_index", async () => {
    const { uow, calls } = fakeUow({ commitFailures: 1, winnerAfterFailure: true });
    const { useCase, counted } = useCaseWith(uow);

    const result = await useCase.execute(command, meta);

    expect(result.idempotentReplay).toBe(true);
    expect(result.transaction.id).toBe(winner().id);
    expect(calls.runs).toBe(3);
    expect(counted).toEqual(["unique_index"]);
  });

  it("D17.6: a repetição bate de novo num UNIQUE → ConcurrentSubmissionError (transitório, 503 + Retry-After), sem 3ª tentativa", async () => {
    const { uow, calls } = fakeUow({ commitFailures: 2, winnerAfterFailure: false });
    const { useCase, counted } = useCaseWith(uow);

    const failure = useCase.execute(command, meta);

    await expect(failure).rejects.toBeInstanceOf(ConcurrentSubmissionError);
    await expect(failure).rejects.toBeInstanceOf(TransientError);
    expect(calls.runs).toBe(3);
    expect(counted).toEqual(["unique_index", "unique_index"]);
  });

  it("D17.7: replay pela checagem rápida conta fast_path", async () => {
    const { uow } = fakeUow({ commitFailures: 0, winnerAfterFailure: false });
    const scopeUow: UnitOfWork = {
      run: (work) =>
        uow.run((scope) =>
          work({
            ...scope,
            transactions: { ...scope.transactions, findByProviderAndKey: async () => winner() },
          }),
        ),
    };
    const { useCase, counted } = useCaseWith(scopeUow);

    const result = await useCase.execute(command, meta);

    expect(result.idempotentReplay).toBe(true);
    expect(counted).toEqual(["fast_path"]);
  });
});
