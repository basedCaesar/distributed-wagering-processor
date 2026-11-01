import { describe, expect, it } from "bun:test";
import {
  DuplicateTransactionError,
  InboxConflictError,
} from "../../../src/modules/wagering/application/errors";
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
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../../../src/modules/wagering/domain/wager-transaction";
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

/** A transação que "ganhou" fora do lock desta wallet, com o mesmo payload (D3.6). */
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
 * Escopo em memória que registra a ordem das chamadas ao banco. Com
 * `uniqueBarrierOnFirstCommit`, o "commit" da 1ª transação falha com
 * `DuplicateTransactionError` e a vencedora fica visível (D3.6).
 */
function fakeUow(registration: InboxRegistration, options: { uniqueBarrierOnFirstCommit?: boolean } = {}) {
  const calls: string[] = [];
  const registered: InboxEntry[] = [];
  let barrierLeft = options.uniqueBarrierOnFirstCommit ?? false;
  let visible: WagerTransaction | undefined;
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
        return visible;
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
      const result = await work(scope);
      if (barrierLeft) {
        // O UNIQUE barrou o commit: tudo desfeito, inclusive a inbox.
        barrierLeft = false;
        visible = winner();
        calls.push("ROLLBACK");
        throw new DuplicateTransactionError("wager_transactions_provider_key_uq");
      }
      return result;
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

  it("D3.6 D19.4: o UNIQUE barra o commit → a repetição grava a inbox de novo, na mesma transação do replay", async () => {
    const { uow, calls, registered } = fakeUow("new", { uniqueBarrierOnFirstCommit: true });
    const { useCase, counted } = useCaseWith(uow);

    const result = await useCase.execute(command, meta, inbox);

    expect(result).toMatchObject({ idempotentReplay: true, transaction: { id: winner().id } });
    expect(counted).toEqual(["unique_index"]);
    // Duas transações: a 1ª desfeita pelo UNIQUE, a 2ª (a que commita o
    // replay) começa de novo pela inbox, antes do lock da wallet.
    const rollback = calls.indexOf("ROLLBACK");
    const retry = calls.slice(rollback + 1);
    expect(calls.slice(0, 3)).toEqual(["BEGIN", "inbox.register", "wallets.lockById"]);
    expect(retry.slice(0, 3)).toEqual(["BEGIN", "inbox.register", "wallets.lockById"]);
    expect(registered).toHaveLength(2);
    expect(registered[1]).toEqual(registered[0]);
  });

  it("R-10-03: sem inbox (HTTP), o caminho continua o da S4: checagem rápida e nenhuma inbox", async () => {
    const { uow, calls } = fakeUow("new");
    const { useCase } = useCaseWith(uow);

    await useCase.execute(command, meta);

    expect(calls).not.toContain("inbox.register");
    expect(calls.slice(0, 2)).toEqual(["BEGIN", "transactions.findByProviderAndKey"]);
  });
});
