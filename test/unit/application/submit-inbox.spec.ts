import { describe, expect, it } from "bun:test";
import { InboxConflictError } from "../../../src/modules/wagering/application/errors";
import { inboxHash, payloadHash } from "../../../src/modules/wagering/application/payload-hash";
import type {
  DuplicateLayer,
  InboxEntry,
  InboxRegistration,
  TransactionScope,
  UnitOfWork,
} from "../../../src/modules/wagering/application/ports";
import {
  type SubmitWagerTransactionCommand,
  SubmitWagerTransactionUseCase,
} from "../../../src/modules/wagering/application/submit-wager-transaction.use-case";
import { WagerTransactionKind } from "../../../src/modules/wagering/domain/wager-transaction";
import { Wallet } from "../../../src/modules/wagering/domain/wallet";
import { brl, T0 } from "../../support/wager-fixtures";

const WALLET_ID = "0192f291-27dd-7d3f-8071-5f8685deef37";

const command: SubmitWagerTransactionCommand = {
  idempotencyKey: "provider-a:tx-1",
  providerId: "provider-a",
  externalTransactionId: "tx-1",
  playerId: "player-1",
  walletId: WALLET_ID,
  roundId: "round-1",
  gameId: "game-1",
  kind: WagerTransactionKind.Bet,
  money: brl("10.00"),
  referenceExternalTransactionId: undefined,
};

const inbox = { consumerName: "consumer-test", messageId: "msg-1", type: "WagerTransactionRequested" };

/** Escopo em memória que registra a ordem das chamadas ao banco. */
function fakeUow(registration: InboxRegistration) {
  const calls: string[] = [];
  const registered: InboxEntry[] = [];
  const scope = {
    now: async () => T0,
    inbox: {
      register: async (entry: InboxEntry) => {
        calls.push("inbox.register");
        registered.push(entry);
        return registration;
      },
    },
    wallets: {
      lockById: async () => {
        calls.push("wallets.lockById");
        return Wallet.rehydrate({
          id: WALLET_ID,
          playerId: "player-1",
          currency: "BRL",
          balance: brl("100.00"),
          version: 1,
          createdAt: T0,
          updatedAt: T0,
        });
      },
      update: () => {},
    },
    transactions: {
      findByProviderAndKey: async () => {
        calls.push("transactions.findByProviderAndKey");
        return undefined;
      },
      findByProviderAndExternalId: async () => undefined,
      insert: () => calls.push("transactions.insert"),
      nudgeDependents: async () => {},
    },
    ledger: { insert: () => {} },
    outbox: { append: () => {} },
  } as unknown as TransactionScope;
  const uow: UnitOfWork = {
    async run(work) {
      calls.push("BEGIN");
      return work(scope);
    },
  };
  return { uow, calls, registered };
}

function useCaseWith(uow: UnitOfWork) {
  const counted: DuplicateLayer[] = [];
  let sequence = 0;
  const useCase = new SubmitWagerTransactionUseCase(
    uow,
    { next: () => `0192f2a0-0000-7000-8000-${String(++sequence).padStart(12, "0")}` },
    { countDuplicate: (layer) => counted.push(layer) },
  );
  return { useCase, counted };
}

const meta = { correlationId: "msg-1", causationId: "msg-1" };

describe("R-10-04 D3.7 D3.8 D19.4: inbox no use case da submissão", () => {
  it("D19.4: a inbox é o primeiro comando da transação, antes do lock da wallet; sem checagem rápida", async () => {
    const { uow, calls, registered } = fakeUow("new");
    const { useCase } = useCaseWith(uow);

    const result = await useCase.execute(command, meta, inbox);

    expect(result).toMatchObject({ idempotentReplay: false });
    expect(calls.slice(0, 3)).toEqual(["BEGIN", "inbox.register", "wallets.lockById"]);
    expect(calls.filter((call) => call === "BEGIN")).toHaveLength(1);
    expect(registered).toEqual([
      {
        consumerName: "consumer-test",
        messageId: "msg-1",
        hash: inboxHash(payloadHash(command), "WagerTransactionRequested"),
      },
    ]);
  });

  it("D3.8: o hash da inbox é o payloadHash mais o type; muda com o type, não com a key", () => {
    const base = inboxHash(payloadHash(command), "WagerTransactionRequested");
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(inboxHash(payloadHash({ ...command, idempotencyKey: "outra" } as typeof command), "WagerTransactionRequested")).toBe(base);
    expect(inboxHash(payloadHash(command), "OutroTipo")).not.toBe(base);
    expect(base).not.toBe(payloadHash(command));
  });

  it("R-10-09 D19.4 D17.7: mensagem já processada → duplicata, sem lock da wallet, contada na camada inbox", async () => {
    const { uow, calls } = fakeUow("duplicate");
    const { useCase, counted } = useCaseWith(uow);

    const result = await useCase.execute(command, meta, inbox);

    expect(result).toEqual({ duplicateMessage: true });
    expect(calls).toEqual(["BEGIN", "inbox.register"]);
    expect(counted).toEqual(["inbox"]);
  });

  it("D3.8 D19.4: mesmo messageId com outro hash → InboxConflictError, sem lock da wallet", async () => {
    const { uow, calls } = fakeUow("conflict");
    const { useCase } = useCaseWith(uow);

    await expect(useCase.execute(command, meta, inbox)).rejects.toBeInstanceOf(InboxConflictError);
    expect(calls).toEqual(["BEGIN", "inbox.register"]);
  });

  it("R-10-03: sem inbox (HTTP), o caminho continua o da S4: checagem rápida e nenhuma inbox", async () => {
    const { uow, calls } = fakeUow("new");
    const { useCase } = useCaseWith(uow);

    await useCase.execute(command, meta);

    expect(calls).not.toContain("inbox.register");
    expect(calls.slice(0, 2)).toEqual(["BEGIN", "transactions.findByProviderAndKey"]);
  });
});
