import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeJwt } from "jose";
import type { AuthConfig } from "../../src/shared/auth/auth.config";
import { type ErrorBody, newPlayerId, startTestApi, type TestApi, type WalletBody } from "../support/api";
import { expectLedgerMatchesBalances } from "../support/db-ledger-invariant";
import { brl, type TestWallet, wagerBody } from "../support/wagering";

/**
 * e2e contra o Keycloak real do Compose de teste (D10.3, D23.5): tokens
 * pedidos por `client_credentials` e validados pelo mesmo adaptador `jose`
 * da produção, com o JWKS do Keycloak. Só a api roda no processo de teste.
 */

const KEYCLOAK_URL = process.env.E2E_KEYCLOAK_URL ?? "";
const REALM_URL = `${KEYCLOAK_URL}/realms/wagering`;
const REALM_FILE = join(import.meta.dir, "..", "..", "keycloak", "realm-wagering.json");

const AUTH: AuthConfig = {
  issuer: REALM_URL,
  audience: "wagering-api",
  jwksUrl: `${REALM_URL}/protocol/openid-connect/certs`,
  jwksTimeoutMs: 5000,
};

/** Segredos de dev do próprio realm (D23.4: não são segredos reais). */
let secrets: Map<string, string>;
let api: TestApi;

async function keycloakToken(clientId: string): Promise<string> {
  const secret = secrets.get(clientId);
  if (secret === undefined) throw new Error(`client ${clientId} sem segredo no realm`);
  const response = await fetch(`${REALM_URL}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret }),
  });
  if (response.status !== 200) {
    throw new Error(`Keycloak recusou o token de ${clientId}: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { access_token: string }).access_token;
}

async function createWallet(amount: string): Promise<TestWallet> {
  const playerId = newPlayerId();
  const response = await api.request("POST", "/wallets", {
    token: await keycloakToken("operator"),
    body: { playerId, initialBalance: brl(amount) },
  });
  expect(response.status).toBe(201);
  const wallet = (await response.json()) as WalletBody;
  return { id: wallet.id, playerId };
}

async function submitAs(clientId: string, body: Record<string, unknown>): Promise<Response> {
  return api.request("POST", "/wagering/transactions", {
    token: await keycloakToken(clientId),
    body,
    headers: { "idempotency-key": `${body.providerId}:${body.externalTransactionId}` },
  });
}

beforeAll(async () => {
  if (KEYCLOAK_URL === "") throw new Error("E2E_KEYCLOAK_URL não definido (.env.test)");
  const realm = JSON.parse(await readFile(REALM_FILE, "utf8")) as {
    clients: { clientId: string; secret?: string }[];
  };
  secrets = new Map(
    realm.clients.flatMap((c) => (c.secret === undefined ? [] : [[c.clientId, c.secret] as [string, string]])),
  );
  api = await startTestApi({ auth: AUTH });
});

afterEach(async () => {
  await expectLedgerMatchesBalances();
});

afterAll(async () => {
  await api?.close();
});

describe("R-02-03 D10 D23.5: e2e com o Keycloak real", () => {
  it("D16.1 D23.3: o token do Keycloak traz o emissor fixo, a audiência, realm_access.roles e provider_id", async () => {
    const provider = decodeJwt(await keycloakToken("provider-a"));
    expect(provider.iss).toBe(REALM_URL);
    expect([provider.aud].flat()).toContain("wagering-api");
    expect((provider.realm_access as { roles: string[] }).roles).toContain("provider");
    expect(provider.provider_id).toBe("provider-a");

    const operator = decodeJwt(await keycloakToken("operator"));
    expect((operator.realm_access as { roles: string[] }).roles).toContain("operator");
    expect(operator.provider_id).toBeUndefined();
  });

  it("R-02-03 D10.1 D10.2: token do operator do Keycloak cria wallet → 201", async () => {
    const wallet = await createWallet("100.00");
    const response = await api.request("GET", `/wallets/${wallet.id}`, { token: await keycloakToken("operator") });
    expect(response.status).toBe(200);
    expect(((await response.json()) as WalletBody).balance).toEqual(brl("100.00"));
  });

  it("R-02-03 D10.1 D10.2: token do provider-a submete BET → 200 PROCESSED, saldo debitado", async () => {
    const wallet = await createWallet("100.00");
    const response = await submitAs("provider-a", wagerBody(wallet, { money: brl("25.00") }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "PROCESSED",
      balance: brl("75.00"),
      idempotentReplay: false,
    });
  });

  it("D10.2: providerId do corpo ≠ provider do token (provider-b) → 403", async () => {
    const wallet = await createWallet("100.00");
    const response = await submitAs("provider-b", wagerBody(wallet));
    expect(response.status).toBe(403);
    expect(((await response.json()) as ErrorBody).error.code).toBe("FORBIDDEN");
  });

  it("D10.2: provider-b consulta transação do provider-a → 404; o provider-a a vê", async () => {
    const wallet = await createWallet("100.00");
    const submitted = await submitAs("provider-a", wagerBody(wallet));
    expect(submitted.status).toBe(200);
    const { transactionId } = (await submitted.json()) as { transactionId: string };

    const foreign = await api.request("GET", `/wagering/transactions/${transactionId}`, {
      token: await keycloakToken("provider-b"),
    });
    expect(foreign.status).toBe(404);
    const own = await api.request("GET", `/wagering/transactions/${transactionId}`, {
      token: await keycloakToken("provider-a"),
    });
    expect(own.status).toBe(200);
  });

  it("D10.2: provider não cria wallet → 403; operator não submete → 403", async () => {
    const asProvider = await api.request("POST", "/wallets", {
      token: await keycloakToken("provider-a"),
      body: { playerId: newPlayerId(), initialBalance: brl("10.00") },
    });
    expect(asProvider.status).toBe(403);

    const wallet = await createWallet("100.00");
    const asOperator = await submitAs("operator", wagerBody(wallet));
    expect(asOperator.status).toBe(403);
  });
});
