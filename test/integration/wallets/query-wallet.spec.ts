import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "pg";
import {
  type ErrorBody,
  type MoneyJson,
  newPlayerId,
  startTestApi,
  type TestApi,
  type WalletBody,
} from "../../support/api";
import { connect, newId } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import {
  credit,
  debitBet,
  type SeededWallet,
  seedWallet,
} from "../../support/db-seed";

interface LedgerItem {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyJson;
  balanceBefore: MoneyJson;
  balanceAfter: MoneyJson;
  walletVersion: number;
  createdAt: string;
}

interface LedgerPage {
  items: LedgerItem[];
  nextCursor: string | null;
}

let api: TestApi;
let db: Client;

beforeAll(async () => {
  api = await startTestApi();
  db = await connect("app");
});

// Todo teste que move dinheiro termina com o invariante (CLAUDE.md, D11.4).
afterEach(async () => {
  await expectLedgerMatchesBalances();
});

afterAll(async () => {
  await api.close();
  await db.end();
});

async function ledgerPage(walletId: string, query = ""): Promise<LedgerPage> {
  const response = await api.request("GET", `/wallets/${walletId}/ledger${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as LedgerPage;
}

/** Wallet com OPENING (v1) e `moves` movimentos alternados (v2..). */
async function walletWithEntries(moves: number): Promise<SeededWallet> {
  const wallet = await seedWallet(db, { balance: "1000.00" });
  for (let i = 0; i < moves; i++) {
    if (i % 2 === 0) await debitBet(db, wallet, "10.00");
    else await credit(db, wallet, "3.00");
  }
  return wallet;
}

describe("S3 R-09-06 D5: GET /wallets/:id", () => {
  it("R-09-06 D5: devolve { id, playerId, balance, version }, o mesmo formato da criação", async () => {
    const playerId = newPlayerId();
    const created = await api.request("POST", "/wallets", {
      body: { playerId, initialBalance: { amount: "42.50", currency: "USD" } },
    });
    const wallet = (await created.json()) as WalletBody;

    const response = await api.request("GET", `/wallets/${wallet.id}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(wallet);
  });

  it("R-06-27 D6.2: depois de movimentos, a version acompanha o último lançamento", async () => {
    const wallet = await walletWithEntries(3);

    const response = await api.request("GET", `/wallets/${wallet.id}`);
    const body = (await response.json()) as WalletBody;

    expect(body.balance).toEqual({ amount: wallet.balance, currency: "BRL" });
    expect(body.version).toBe(4);
  });

  it("D5 D16.2: wallet inexistente → 404 NOT_FOUND", async () => {
    const response = await api.request("GET", `/wallets/${newId()}`);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("D16.8: walletId que não é UUID → 400 VALIDATION_ERROR", async () => {
    const response = await api.request("GET", "/wallets/not-a-uuid");
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("S3 R-09-07 D6.8: GET /wallets/:id/ledger", () => {
  it("R-09-07 D6.8 D5: itens em ordem crescente de walletVersion, no formato da D5", async () => {
    const wallet = await walletWithEntries(2);

    const page = await ledgerPage(wallet.id);

    expect(page.items.map((item) => item.walletVersion)).toEqual([1, 2, 3]);
    expect(page.items[0]).toEqual({
      id: expect.any(String),
      transactionId: wallet.openingTransactionId as string,
      direction: "CREDIT",
      money: { amount: "1000.00", currency: "BRL" },
      balanceBefore: { amount: "0.00", currency: "BRL" },
      balanceAfter: { amount: "1000.00", currency: "BRL" },
      walletVersion: 1,
      createdAt: expect.any(String),
    });
    expect(page.items[1]).toMatchObject({
      direction: "DEBIT",
      balanceBefore: { amount: "1000.00", currency: "BRL" },
      balanceAfter: { amount: "990.00", currency: "BRL" },
    });
    expect(page.nextCursor).toBeNull();
  });

  it("D6.8: limit padrão 50", async () => {
    const wallet = await walletWithEntries(54);

    const page = await ledgerPage(wallet.id);

    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();
  });

  it("R-09-07 D6.8: o cursor percorre tudo sem duplicata nem furo", async () => {
    const wallet = await walletWithEntries(6);
    const versions: number[] = [];

    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
      const page = await ledgerPage(wallet.id, query);
      versions.push(...page.items.map((item) => item.walletVersion));
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("R-09-07 D6.8 D16.9: cursor estável: lançamentos gravados entre as páginas aparecem na seguinte, sem duplicata nem furo", async () => {
    const wallet = await walletWithEntries(3);
    const first = await ledgerPage(wallet.id, "?limit=2");
    expect(first.items.map((item) => item.walletVersion)).toEqual([1, 2]);

    // Lançamentos novos chegam entre a primeira e a segunda página.
    await debitBet(db, wallet, "1.00");
    await credit(db, wallet, "1.00");

    const second = await ledgerPage(
      wallet.id,
      `?limit=10&cursor=${first.nextCursor}`,
    );
    expect(second.items.map((item) => item.walletVersion)).toEqual([3, 4, 5, 6]);
    expect(second.nextCursor).toBeNull();
  });

  it("D6.8: wallet sem lançamentos → página vazia", async () => {
    const created = await api.request("POST", "/wallets", {
      body: {
        playerId: newPlayerId(),
        initialBalance: { amount: "0.00", currency: "BRL" },
      },
    });
    const wallet = (await created.json()) as WalletBody;

    expect(await ledgerPage(wallet.id)).toEqual({ items: [], nextCursor: null });
  });

  it.each([
    ["cursor adulterado", "?cursor=@@@"],
    ["cursor de versão zero", `?cursor=${Buffer.from("0").toString("base64url")}`],
    ["limit 0", "?limit=0"],
    ["limit 201", "?limit=201"],
    ["limit não numérico", "?limit=abc"],
    ["limit decimal", "?limit=1.5"],
  ])("D6.8 D5 D16.2: %s → 400 VALIDATION_ERROR", async (_, query) => {
    const wallet = await seedWallet(db, { balance: "10.00" });

    const response = await api.request("GET", `/wallets/${wallet.id}/ledger${query}`);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("D6.8: limit 200 é aceito", async () => {
    const wallet = await seedWallet(db, { balance: "10.00" });

    expect((await ledgerPage(wallet.id, "?limit=200")).items).toHaveLength(1);
  });

  it("D5: ledger de wallet inexistente → 404", async () => {
    const response = await api.request("GET", `/wallets/${newId()}/ledger`);

    expect(response.status).toBe(404);
  });
});
