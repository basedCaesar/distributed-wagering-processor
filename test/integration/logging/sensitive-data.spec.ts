import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { UnitOfWork } from "../../../src/modules/wagering/application/ports";
import { UNIT_OF_WORK } from "../../../src/modules/wagering/application/ports";
import { logger } from "../../../src/shared/logger/logger";
import {
  type ErrorBody,
  newPlayerId,
  startTestApi,
  type TestApi,
  type WalletBody,
} from "../../support/api";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { type Tampering, tamperWalletBalance } from "../../support/tamper";

/**
 * D11.1 nos caminhos que **logam**: divergência de reconciliação (log de
 * erro, R-09-19) e erro interno (`500`, filtro HTTP). Os logs vêm do logger
 * singleton, capturado pelo `startTestApi`.
 */

let api: TestApi;
let tampering: Tampering | undefined;

beforeAll(async () => {
  api = await startTestApi();
});

afterEach(async () => {
  await tampering?.restore();
  tampering = undefined;
});

afterAll(async () => {
  await api.close();
  await expectLedgerMatchesBalances();
});

const brl = (amount: string) => ({ amount, currency: "BRL" });

/** Banco que falha com uma constraint sem tradução, como o `pg` entrega, com dados no `detail`. */
function failingUnitOfWork(playerId: string): UnitOfWork {
  return {
    run: async () => {
      throw Object.assign(new Error(`violação para ${playerId} com 555.55`), {
        code: "23514",
        constraint: "wallets_balance_ck",
        detail: `Failing row contains (${playerId}, 555.55).`,
      });
    },
  };
}

describe("S3 D11.1: logs sem valor, saldo, playerId nem token", () => {
  it("D11.1: o logger singleton (import direto) também é capturado", () => {
    const marker = `marcador-${Bun.randomUUIDv7()}`;

    logger.warn({ marker }, "log direto pelo singleton");

    expect(api.logs).toContainEqual(expect.objectContaining({ marker }));
  });

  it("D11.1 R-09-19 D6.9: divergência de reconciliação loga erro sem saldos, diferença, playerId nem token", async () => {
    const playerId = newPlayerId();
    const created = await api.request("POST", "/wallets", {
      body: { playerId, initialBalance: brl("777.77") },
    });
    const wallet = (await created.json()) as WalletBody;
    tampering = await tamperWalletBalance(wallet.id, "888.88");
    const token = await api.issuer.operatorToken();

    const response = await api.request(
      "POST",
      `/wallets/${wallet.id}/reconciliation`,
      { token },
    );

    expect(response.status).toBe(200);
    const divergence = api.logs.find(
      (line) => line.walletId === wallet.id && line.level === 50,
    );
    expect(divergence).toMatchObject({ issues: ["BALANCE_MISMATCH", "TAIL_MISMATCH"] });
    const dump = JSON.stringify(api.logs);
    for (const secret of [playerId, "777.77", "888.88", "111.11", token]) {
      expect(dump).not.toContain(secret);
    }
  });

  it("D11.1 D5: erro interno (500) loga só a identificação do erro, sem a mensagem nem o detail do banco", async () => {
    const playerId = newPlayerId();
    const failing = await startTestApi({
      overrides: [{ provide: UNIT_OF_WORK, useValue: failingUnitOfWork(playerId) }],
    });
    try {
      const token = await failing.issuer.operatorToken();

      const response = await failing.request("POST", "/wallets", {
        token,
        body: { playerId, initialBalance: brl("555.55") },
      });
      const body = (await response.json()) as ErrorBody;

      expect(response.status).toBe(500);
      expect(body.error.code).toBe("INTERNAL_ERROR");
      expect(JSON.stringify(body)).not.toContain(playerId);
      const failure = failing.logs.find((line) => line.msg === "requisição falhou");
      expect(failure).toMatchObject({
        level: 50,
        category: "internal",
        code: "23514",
        constraint: "wallets_balance_ck",
      });
      const dump = JSON.stringify(failing.logs);
      for (const secret of [playerId, "555.55", token]) {
        expect(dump).not.toContain(secret);
      }
    } finally {
      await failing.close();
    }
  });
});
