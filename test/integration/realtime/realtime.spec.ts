import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startTestApi, type TestApi } from "../../support/api";
import { startTestIssuer } from "../../support/auth";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { startHoldingProxy } from "../../support/holding-proxy";
import {
  createTestTopic,
  parkAllOutbox,
  runPublisherUntil,
  startTestPublisher,
  type TestPublisher,
  type TestTopic,
  unpublishedCount,
} from "../../support/outbox";
import { deleteInstanceQueue, startTestRealtime, type TestRealtime } from "../../support/realtime";
import { brl, createWallet, submit, wagerBody } from "../../support/wagering";
import { balanceVersions, type EventMessage, followingClient, openClient } from "../../support/ws-client";

/** A subida da API, do realtime e as idas ao LocalStack não cabem nos 5 s padrão do bun. */
const SLOW_TEST_MS = 60_000;
/** Curto para o teste do `4408` (D28.2); os outros clientes mandam o `auth` na hora. */
const AUTH_TIMEOUT_MS = 1000;

let topic: TestTopic;
let publisher: TestPublisher;
let api: TestApi;
let realtime: TestRealtime;

beforeAll(async () => {
  topic = await createTestTopic();
  publisher = await startTestPublisher(topic);
  api = await startTestApi();
  realtime = await startTestRealtime({
    topicArn: topic.topicArn,
    auth: api.issuer.config,
    overrides: { authTimeoutMs: AUTH_TIMEOUT_MS, maxFollowsPerConnection: 3 },
  });
}, SLOW_TEST_MS);

afterAll(async () => {
  await realtime?.close();
  if (realtime) await deleteInstanceQueue(realtime.instanceId);
  await api?.close();
  await publisher?.close();
  await topic?.destroy();
});

beforeEach(async () => {
  // O acúmulo das outras fatias não entra no lote do publisher do teste (D20.8).
  await parkAllOutbox();
});

/** Publica tudo o que está na outbox das wallets (publisher real → SNS → fila da instância). */
async function publishAll(walletIds: readonly string[]): Promise<void> {
  await runPublisherUntil(publisher, async () => (await unpublishedCount(walletIds)) === 0);
}

const isEvent = (eventType: string, walletId: string, check: (event: EventMessage) => boolean = () => true) =>
  (message: { type: string }) => {
    const event = message as EventMessage;
    return event.type === "event" && event.eventType === eventType && event.walletId === walletId && check(event);
  };

describe("D28 V-01 V-03: WebSocket de tempo real", () => {
  it("D28.2 D28.4 V-03: token válido segue a wallet e recebe os eventos de uma BET feita pelo HTTP, em ordem", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const client = await followingClient(realtime.url, await api.issuer.operatorToken(), [wallet.id]);
    try {
      const bet = await submit(api, wagerBody(wallet, { kind: "BET", money: brl("25.00") }));
      expect(bet.status).toBe(200);
      await publishAll([wallet.id]);

      const balance = await client.waitFor(
        isEvent("WalletBalanceChanged", wallet.id, (event) => event.walletVersion === 2),
        "WalletBalanceChanged v2",
      );
      expect(balance).toEqual({
        type: "event",
        eventId: expect.any(String),
        eventType: "WalletBalanceChanged",
        occurredAt: expect.any(String),
        walletId: wallet.id,
        walletVersion: 2,
        data: {
          transactionId: bet.body.transactionId,
          direction: "DEBIT",
          money: brl("25.00"),
          balanceBefore: brl("100.00"),
          balanceAfter: brl("75.00"),
        },
      });
      const processed = await client.waitFor(
        isEvent("WagerTransactionProcessed", wallet.id, (event) => event.data.transactionId === bet.body.transactionId),
        "WagerTransactionProcessed da BET",
      );
      expect(processed).toMatchObject({
        walletVersion: 2,
        data: { kind: "BET", status: "PROCESSED", providerId: "provider-a", money: brl("25.00"), balanceAfter: brl("75.00") },
      });
      expect(JSON.stringify(processed)).not.toContain(wallet.playerId);
      // A abertura também chegou (o follow veio antes da publicação), e as versões vêm em ordem.
      expect(balanceVersions(client, wallet.id)).toEqual([1, 2]);
      expect(client.events().some((event) => event.eventType === "WalletOpened")).toBe(true);
    } finally {
      client.close();
    }
    await expectLedgerMatchesBalances();
  }, SLOW_TEST_MS);

  it("D28.2: sem o auth no prazo → fecha com 4408", async () => {
    const client = await openClient(realtime.url);

    expect((await client.closed).code).toBe(4408);
  }, SLOW_TEST_MS);

  it.each([
    ["sem token (vazio)", async () => ({ type: "auth", token: "" })],
    ["token assinado por outra chave", async () => ({ type: "auth", token: await api.issuer.token({ foreignKey: true }) })],
    ["token vencido", async () => ({ type: "auth", token: await api.issuer.token({ expiresIn: -60 }) })],
    ["token sem papel (D16.1)", async () => ({ type: "auth", token: await api.issuer.token({ roles: [] }) })],
    ["token de outra audiência", async () => ({ type: "auth", token: await api.issuer.token({ audience: "outra" }) })],
  ])("D28.2 D10.3: %s → fecha com 4401", async (_, frame) => {
    const client = await openClient(realtime.url);
    client.send(await frame());

    expect((await client.closed).code).toBe(4401);
    expect(client.messages.filter((message) => message.type === "authenticated")).toEqual([]);
  }, SLOW_TEST_MS);

  it.each([
    ["follow antes do auth", JSON.stringify({ type: "follow", walletId: Bun.randomUUIDv7() })],
    ["JSON quebrado antes do auth", "{"],
  ])("D28.2: %s → fecha com 4400", async (_, frame) => {
    const client = await openClient(realtime.url);
    client.sendRaw(frame);

    expect((await client.closed).code).toBe(4400);
  }, SLOW_TEST_MS);

  it("D28.2: frame binário antes do auth → fecha com 4400, mesmo com um auth válido dentro", async () => {
    const client = await openClient(realtime.url);
    const frame = JSON.stringify({ type: "auth", token: await api.issuer.operatorToken() });
    client.sendBinary(new TextEncoder().encode(frame));

    expect((await client.closed).code).toBe(4400);
    expect(client.messages.filter((message) => message.type === "authenticated")).toEqual([]);
  }, SLOW_TEST_MS);

  it("D28.2: frame acima de 4 KB → fecha com 1009", async () => {
    const client = await openClient(realtime.url);
    client.sendRaw(JSON.stringify({ type: "auth", token: "x".repeat(5000) }));

    expect((await client.closed).code).toBe(1009);
  }, SLOW_TEST_MS);

  it("D28.2: token que vence durante a conexão → fecha com 4401", async () => {
    const client = await followingClient(realtime.url, await api.issuer.token({ roles: ["operator"], providerId: null, expiresIn: 2 }), []);

    expect((await client.closed).code).toBe(4401);
  }, SLOW_TEST_MS);

  it("D28.2: depois do auth, frame inválido responde VALIDATION_ERROR sem fechar; a 4ª wallet responde FOLLOW_LIMIT", async () => {
    const ids = [Bun.randomUUIDv7(), Bun.randomUUIDv7(), Bun.randomUUIDv7()];
    const client = await followingClient(realtime.url, await api.issuer.operatorToken(), ids);
    try {
      client.sendRaw("{");
      await client.waitFor((message) => message.type === "error" && message.code === "VALIDATION_ERROR", "erro do JSON");
      client.send({ type: "follow", walletId: "nao-e-uuid" });
      client.send({ type: "auth", token: await api.issuer.operatorToken() });
      await client.waitFor(
        () => client.messages.filter((message) => message.type === "error" && message.code === "VALIDATION_ERROR").length === 3,
        "3 erros de validação",
      );
      const fourth = Bun.randomUUIDv7();
      client.send({ type: "follow", walletId: fourth });
      const limit = await client.waitFor((message) => message.type === "error" && message.code === "FOLLOW_LIMIT", "FOLLOW_LIMIT");

      expect(limit).toEqual({ type: "error", code: "FOLLOW_LIMIT", walletId: fourth });
      // Deixar uma wallet libera a vaga.
      client.send({ type: "unfollow", walletId: ids[0] });
      await client.waitFor((message) => message.type === "unfollowed" && message.walletId === ids[0], "unfollowed");
      client.send({ type: "follow", walletId: fourth });
      await client.waitFor((message) => message.type === "followed" && message.walletId === fourth, "followed da 4ª");
    } finally {
      client.close();
    }
  }, SLOW_TEST_MS);

  it("D28.2: não recebe eventos de outra wallet", async () => {
    const walletA = await createWallet(api, brl("100.00"));
    const walletB = await createWallet(api, brl("100.00"));
    const token = await api.issuer.operatorToken();
    const followerA = await followingClient(realtime.url, token, [walletA.id]);
    const controlB = await followingClient(realtime.url, token, [walletB.id]);
    try {
      expect((await submit(api, wagerBody(walletB, { kind: "BET", money: brl("10.00") }))).status).toBe(200);
      await publishAll([walletA.id, walletB.id]);
      // O evento de B passou pela instância: chegou ao cliente de controle.
      await controlB.waitFor(isEvent("WalletBalanceChanged", walletB.id, (event) => event.walletVersion === 2), "B v2 no controle");

      expect((await submit(api, wagerBody(walletA, { kind: "BET", money: brl("10.00") }))).status).toBe(200);
      await publishAll([walletA.id]);
      await followerA.waitFor(isEvent("WalletBalanceChanged", walletA.id, (event) => event.walletVersion === 2), "A v2");

      expect(followerA.events().filter((event) => event.walletId !== walletA.id)).toEqual([]);
      expect(JSON.stringify(followerA.messages)).not.toContain(walletB.id);
    } finally {
      followerA.close();
      controlB.close();
    }
    await expectLedgerMatchesBalances();
  }, SLOW_TEST_MS);

  it("D28.3 D10.2: o saldo vai para todos os que seguem; a transação, só ao provedor dela e ao operador", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const operator = await followingClient(realtime.url, await api.issuer.operatorToken(), [wallet.id]);
    const providerA = await followingClient(realtime.url, await api.issuer.providerToken("provider-a"), [wallet.id]);
    const providerB = await followingClient(realtime.url, await api.issuer.providerToken("provider-b"), [wallet.id]);
    try {
      const betA = await submit(api, wagerBody(wallet, { providerId: "provider-a", kind: "BET", money: brl("10.00") }));
      const betB = await submit(api, wagerBody(wallet, { providerId: "provider-b", kind: "BET", money: brl("5.00") }));
      expect([betA.status, betB.status]).toEqual([200, 200]);
      await publishAll([wallet.id]);

      // A transação de B é a última do grupo FIFO da wallet: quando ela chega ao
      // operador e ao provedor B, todas as anteriores já passaram pela instância.
      const lastOf = (txId: string) =>
        isEvent("WagerTransactionProcessed", wallet.id, (event) => event.data.transactionId === txId);
      await operator.waitFor(lastOf(betB.body.transactionId), "BET de B no operador");
      await providerB.waitFor(lastOf(betB.body.transactionId), "BET de B no provedor B");
      await providerA.waitFor(isEvent("WalletBalanceChanged", wallet.id, (event) => event.walletVersion === 3), "v3 no provedor A");

      const transactions = (client: typeof operator) =>
        client
          .events()
          .filter((event) => event.eventType === "WagerTransactionProcessed")
          .map((event) => event.data.kind === "OPENING" ? "OPENING" : event.data.transactionId);
      expect(transactions(operator)).toEqual(["OPENING", betA.body.transactionId, betB.body.transactionId]);
      expect(transactions(providerA)).toEqual([betA.body.transactionId]);
      expect(transactions(providerB)).toEqual([betB.body.transactionId]);
      for (const client of [operator, providerA, providerB]) expect(balanceVersions(client, wallet.id)).toEqual([1, 2, 3]);
    } finally {
      operator.close();
      providerA.close();
      providerB.close();
    }
    await expectLedgerMatchesBalances();
  }, SLOW_TEST_MS);

  it("D28.2 D16.16: JWKS do emissor indisponível → fecha com 4503 (reconectar resolve)", async () => {
    const down = await startTestIssuer({ jwks: "status503" });
    const instance = await startTestRealtime({ topicArn: topic.topicArn, auth: down.config });
    try {
      const client = await openClient(instance.url);
      client.send({ type: "auth", token: await down.operatorToken() });

      expect((await client.closed).code).toBe(4503);
    } finally {
      await instance.close();
      await deleteInstanceQueue(instance.instanceId);
      await down.stop();
    }
  }, SLOW_TEST_MS);

  it("D28.2 D16.16: o prazo do auth vale até o frame chegar; JWKS pendurado além dele → 4503, não 4408", async () => {
    // O JWKS real do emissor de teste, atrás do proxy que segura o pedido sem responder.
    const proxy = await startHoldingProxy(new URL(api.issuer.config.jwksUrl).origin);
    const auth = { ...api.issuer.config, jwksUrl: `${proxy.url}/jwks`, jwksTimeoutMs: 3 * AUTH_TIMEOUT_MS };
    const instance = await startTestRealtime({ topicArn: topic.topicArn, auth, overrides: { authTimeoutMs: AUTH_TIMEOUT_MS } });
    try {
      proxy.hold();
      const client = await openClient(instance.url);
      client.send({ type: "auth", token: await api.issuer.operatorToken() });

      // O auth chegou dentro do prazo; quem decide é o timeout do JWKS (3 × o prazo do auth).
      expect((await client.closed).code).toBe(4503);
    } finally {
      await instance.close();
      await deleteInstanceQueue(instance.instanceId);
      await proxy.close();
    }
  }, SLOW_TEST_MS);
});
