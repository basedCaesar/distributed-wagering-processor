import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { LockMode, type MikroORM } from "@mikro-orm/postgresql";
import {
  FailureCode,
  ReferenceScopeField,
} from "../../../src/modules/wagering/domain/failure-code";
import { Money } from "../../../src/modules/wagering/domain/money";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/modules/wagering/domain/wager-transaction";
import { Wallet } from "../../../src/modules/wagering/domain/wallet";
import { WAGERING_ENTITIES } from "../../../src/modules/wagering/infra/persistence";
import { WagerTransactionSchema } from "../../../src/modules/wagering/infra/persistence/wager-transaction.schema";
import {
  wagerTransactionFromRecord,
  wagerTransactionToRecord,
} from "../../../src/modules/wagering/infra/persistence/wager-transaction.mapper";
import { WalletLedgerEntrySchema } from "../../../src/modules/wagering/infra/persistence/wallet-ledger-entry.schema";
import {
  ledgerEntryFromRecord,
  ledgerEntryToRecord,
} from "../../../src/modules/wagering/infra/persistence/wallet-ledger-entry.mapper";
import { WalletSchema } from "../../../src/modules/wagering/infra/persistence/wallet.schema";
import {
  walletFromRecord,
  walletToRecord,
} from "../../../src/modules/wagering/infra/persistence/wallet.mapper";
import { createOrm } from "../../../src/shared/orm/create-orm";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { credentialsFor, newId, withClient } from "../../support/db";

// 9007199254740993 centavos > 2^53: só sobrevive se nunca passar por number.
const BEYOND_FLOAT = "90071992547409.93";
// rehydrate: o saldo aceita até 15 dígitos inteiros (D2.4), a entrada só 12.
const brl = (amount: string) => Money.rehydrate({ amount, currency: "BRL" });

describe("S2 D7.1 D7.2: mapeamento MikroORM (EntitySchema + mappers), papel da app", () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await createOrm({
      credentials: await credentialsFor("app"),
      entities: WAGERING_ENTITIES,
    });
  });

  afterAll(async () => {
    await orm.close();
    await expectLedgerMatchesBalances();
  });

  /** Abre a wallet com OPENING e lançamento numa transação só (D6.2). */
  async function openWallet(initial: string) {
    const at = new Date();
    const transactionId = newId();
    const { wallet, openingEntry } = Wallet.open({
      id: newId(),
      playerId: `player-${newId()}`,
      initialBalance: brl(initial),
      openingTransactionId: transactionId,
      openingEntryId: newId(),
      at,
    });
    const opening = WagerTransaction.opening({
      id: transactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: brl(initial),
      createdAt: at,
    });
    opening.markProcessed({ balanceAfter: wallet.balance, at });
    if (!openingEntry)
      throw new Error("saldo inicial positivo gera lançamento");

    await orm.em.fork().transactional(async (em) => {
      em.create(WalletSchema, walletToRecord(wallet));
      em.create(
        WagerTransactionSchema,
        wagerTransactionToRecord(opening, {
          updatedAt: at,
          correlationId: null,
        }),
      );
      em.create(WalletLedgerEntrySchema, ledgerEntryToRecord(openingEntry));
    });
    return { wallet, opening, openingEntry };
  }

  it("D2.4 D7.1: Wallet, OPENING e lançamento voltam exatos (valor além de 2^53 centavos)", async () => {
    const { wallet, opening, openingEntry } = await openWallet(BEYOND_FLOAT);

    const em = orm.em.fork();
    const walletBack = walletFromRecord(
      await em.findOneOrFail(WalletSchema, wallet.id),
    );
    const openingBack = wagerTransactionFromRecord(
      await em.findOneOrFail(WagerTransactionSchema, opening.id),
    );
    const entryBack = ledgerEntryFromRecord(
      await em.findOneOrFail(WalletLedgerEntrySchema, openingEntry.id),
    );

    expect(walletBack.balance.toString()).toBe(BEYOND_FLOAT);
    expect(walletBack.version).toBe(1);
    expect(openingBack.kind).toBe(WagerTransactionKind.Opening);
    expect(openingBack.providerId).toBeUndefined();
    expect(openingBack.roundId).toBeUndefined();
    expect(openingBack.balanceAfter?.toString()).toBe(BEYOND_FLOAT);
    expect(entryBack).toEqual(openingEntry);
  });

  it("D7.2: débito pelo domínio sob PESSIMISTIC_WRITE grava a version do domínio, sem incremento do ORM", async () => {
    const { wallet: opened } = await openWallet("100.00");

    await orm.em.fork().transactional(async (em) => {
      const record = await em.findOneOrFail(WalletSchema, opened.id, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      });
      const wallet = walletFromRecord(record);
      const at = new Date();
      const bet = WagerTransaction.create({
        id: newId(),
        providerId: "provider-1",
        externalTransactionId: `ext-${newId()}`,
        idempotencyKey: `key-${newId()}`,
        payloadHash: "c".repeat(64),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Bet,
        money: brl("10.00"),
        referenceExternalTransactionId: undefined,
        createdAt: at,
      });
      const entry = wallet.debit({
        money: bet.money,
        transactionId: bet.id,
        entryId: newId(),
        at,
      });
      bet.markProcessed({ balanceAfter: wallet.balance, at });

      em.assign(record, walletToRecord(wallet));
      em.create(
        WagerTransactionSchema,
        wagerTransactionToRecord(bet, { updatedAt: at, correlationId: null }),
      );
      em.create(WalletLedgerEntrySchema, ledgerEntryToRecord(entry));
    });

    const row = await withClient("app", async (client) => {
      const { rows } = await client.query(
        "SELECT balance::text AS balance, version FROM wallets WHERE id = $1",
        [opened.id],
      );
      return rows[0];
    });
    expect(row).toEqual({ balance: "90.00", version: 2 });
  });

  it("D3.5 D14.3: REJECTED por escopo volta com failureDetail e saldo", async () => {
    const { wallet } = await openWallet("50.00");
    const at = new Date();
    const win = WagerTransaction.create({
      id: newId(),
      providerId: "provider-1",
      externalTransactionId: `ext-${newId()}`,
      idempotencyKey: `key-${newId()}`,
      payloadHash: "d".repeat(64),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: "round-2",
      gameId: "game-1",
      kind: WagerTransactionKind.Win,
      money: brl("5.00"),
      referenceExternalTransactionId: "ext-of-other-round",
      createdAt: at,
    });
    win.reject(FailureCode.ReferenceScopeMismatch, {
      balanceAfter: wallet.balance,
      detail: ReferenceScopeField.Round,
    });

    await orm.em
      .fork()
      .transactional(async (em) =>
        em.create(
          WagerTransactionSchema,
          wagerTransactionToRecord(win, { updatedAt: at, correlationId: null }),
        ),
      );
    const back = wagerTransactionFromRecord(
      await orm.em.fork().findOneOrFail(WagerTransactionSchema, win.id),
    );

    expect(back.status).toBe(WagerTransactionStatus.Rejected);
    expect(back.failureCode).toBe(FailureCode.ReferenceScopeMismatch);
    expect(back.failureDetail).toBe(ReferenceScopeField.Round);
    expect(back.balanceAfter?.toString()).toBe("50.00");
    expect(back.referenceTransactionId).toBeUndefined();
  });

  it("D9.5: o INSERT pelo ORM grava o correlation_id recebido por quem salva", async () => {
    const { wallet } = await openWallet("20.00");
    const at = new Date();
    const correlationId = `corr-${newId()}`;
    const loss = WagerTransaction.create({
      id: newId(),
      providerId: "provider-1",
      externalTransactionId: `ext-${newId()}`,
      idempotencyKey: `key-${newId()}`,
      payloadHash: "e".repeat(64),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Loss,
      money: brl("0.00"),
      referenceExternalTransactionId: undefined,
      createdAt: at,
    });
    loss.markProcessed({ balanceAfter: wallet.balance, at });

    await orm.em
      .fork()
      .transactional(async (em) =>
        em.create(
          WagerTransactionSchema,
          wagerTransactionToRecord(loss, { updatedAt: at, correlationId }),
        ),
      );

    const row = await withClient("app", async (client) => {
      const { rows } = await client.query(
        "SELECT correlation_id FROM wager_transactions WHERE id = $1",
        [loss.id],
      );
      return rows[0];
    });
    expect(row).toEqual({ correlation_id: correlationId });
  });

  it("D5: a conexão do ORM tem lock_timeout 2s e statement_timeout 5s", async () => {
    const connection = orm.em.getConnection();
    const [lock] = await connection.execute("SHOW lock_timeout");
    const [statement] = await connection.execute("SHOW statement_timeout");

    expect(lock).toEqual({ lock_timeout: "2s" });
    expect(statement).toEqual({ statement_timeout: "5s" });
  });
});
