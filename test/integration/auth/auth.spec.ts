import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { TokenOptions } from "../../support/auth";
import {
  type ErrorBody,
  newPlayerId,
  startTestApi,
  type TestApi,
  type WalletBody,
} from "../../support/api";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";

let api: TestApi;
let walletId: string;

beforeAll(async () => {
  api = await startTestApi();
  const created = await api.request("POST", "/wallets", {
    body: {
      playerId: newPlayerId(),
      initialBalance: { amount: "10.00", currency: "BRL" },
    },
  });
  walletId = ((await created.json()) as WalletBody).id;
});

afterAll(async () => {
  await api.close();
  await expectLedgerMatchesBalances();
});

const newWalletBody = () => ({
  playerId: newPlayerId(),
  initialBalance: { amount: "1.00", currency: "BRL" },
});

/** Endpoints protegidos da S3, com um corpo válido quando precisam. */
const protectedEndpoints = (): [string, string, unknown][] => [
  ["POST", "/wallets", newWalletBody()],
  ["GET", `/wallets/${walletId}`, undefined],
  ["GET", `/wallets/${walletId}/ledger`, undefined],
  ["POST", `/wallets/${walletId}/reconciliation`, undefined],
];

async function expectError(response: Response, status: number, code: string) {
  const body = (await response.json()) as ErrorBody;
  expect({ status: response.status, code: body.error.code }).toEqual({
    status,
    code,
  });
}

describe("S3 D10 D16.1: autenticação e permissões", () => {
  it("D10.3 R-02-06 D16.2: sem token → 401 UNAUTHENTICATED em todo endpoint protegido", async () => {
    for (const [method, path, body] of protectedEndpoints()) {
      const response = await api.request(method, path, { token: null, body });
      await expectError(response, 401, "UNAUTHENTICATED");
    }
  });

  it("D10.1: header Authorization sem Bearer → 401", async () => {
    const response = await api.request("GET", `/wallets/${walletId}`, {
      token: null,
      headers: { authorization: `Basic ${btoa("a:b")}` },
    });
    await expectError(response, 401, "UNAUTHENTICATED");
  });

  it.each<[string, TokenOptions]>([
    ["expirado", { roles: ["operator"], expiresIn: -10 }],
    ["de outro emissor", { roles: ["operator"], issuer: "https://evil.example" }],
    ["de outra audiência", { roles: ["operator"], audience: "other-api" }],
    ["assinado com chave fora do JWKS", { roles: ["operator"], foreignKey: true }],
    ["HS256 (só RS256 é aceito)", { roles: ["operator"], hs256: true }],
    ["sem papel conhecido", { roles: ["admin"] }],
    ["provider sem provider_id", { roles: ["provider"], providerId: null }],
  ])("D10.1 D16.1: token %s → 401", async (_, options) => {
    const token = await api.issuer.token(options);

    const response = await api.request("GET", `/wallets/${walletId}`, { token });

    await expectError(response, 401, "UNAUTHENTICATED");
  });

  it("D10.1: token que não é JWT → 401", async () => {
    const response = await api.request("GET", `/wallets/${walletId}`, {
      token: "isto-não-é-um-jwt",
    });
    await expectError(response, 401, "UNAUTHENTICATED");
  });

  it("D10.2 D16.2: token provider em POST /wallets → 403 FORBIDDEN, nada criado", async () => {
    const response = await api.request("POST", "/wallets", {
      token: await api.issuer.providerToken(),
      body: newWalletBody(),
    });
    await expectError(response, 403, "FORBIDDEN");
  });

  it("D10.2 D16.2: token provider na reconciliação → 403 FORBIDDEN", async () => {
    const response = await api.request(
      "POST",
      `/wallets/${walletId}/reconciliation`,
      { token: await api.issuer.providerToken() },
    );
    await expectError(response, 403, "FORBIDDEN");
  });

  it("D10.2: provider e operator leem a wallet e o ledger", async () => {
    const tokens = [
      await api.issuer.providerToken(),
      await api.issuer.operatorToken(),
    ];
    for (const token of tokens) {
      for (const path of [`/wallets/${walletId}`, `/wallets/${walletId}/ledger`]) {
        const response = await api.request("GET", path, { token });
        expect(response.status).toBe(200);
      }
    }
  });

  it("D10.2: token com os dois papéis cria wallet (tem o papel operator)", async () => {
    const token = await api.issuer.token({ roles: ["provider", "operator"] });

    const response = await api.request("POST", "/wallets", {
      token,
      body: newWalletBody(),
    });

    expect(response.status).toBe(201);
  });

  it("R-02-06 R-09-20 D13.2: health e /docs abertos, sem token", async () => {
    for (const path of ["/health/live", "/health/ready", "/docs", "/docs-json"]) {
      const response = await fetch(`${api.baseUrl}${path}`);
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
    }
  });

  it("D16.15: JSON mal formado é lido antes da autenticação → 400 mesmo sem token", async () => {
    const response = await fetch(`${api.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ não é json",
    });
    await expectError(response, 400, "VALIDATION_ERROR");
  });

  it("D10.1 D16.15: o guard roda antes da validação do schema (sem token e corpo fora do schema → 401)", async () => {
    const response = await api.request("POST", "/wallets", {
      token: null,
      body: { playerId: "" },
    });
    await expectError(response, 401, "UNAUTHENTICATED");
  });
});
