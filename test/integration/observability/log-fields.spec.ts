import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startTestIssuer, type TestIssuer } from "../../support/auth";
import { wagerMessage } from "../../support/consumer";
import { newId } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { apiClient, authEnv, ProcessGroup, type TestProcess, waitFor } from "../../support/processes";
import { createTestQueues, sendMessage, type TestQueues } from "../../support/sqs";
import { type ApiClient, brl, submit, wagerBody } from "../../support/wagering";

/**
 * R-12-01 R-12-02 D11.1 D22.9: os logs de um fluxo HTTP e de um SQS, como
 * os processos de produção (`api` e `consumer`, entrypoints reais) os
 * escrevem no stdout. Valores distintivos: nenhum deles aparece em outro
 * lugar dos logs.
 */

/** Subir dois processos e esperar a fila: o padrão de 5 s do bun não cabe. */
const SLOW_TEST_MS = 60_000;

const INITIAL = "9105.38";
const HTTP_AMOUNT = "6087.41";
const HTTP_BALANCE = "3017.97";
const SQS_AMOUNT = "1001.13";
const SQS_BALANCE = "2016.84";

let issuer: TestIssuer;
let queues: TestQueues;
let group: ProcessGroup;
let api: TestProcess;
let consumer: TestProcess;
let client: ApiClient;
let operatorToken: string;
let providerToken: string;
const playerId = `player-obs-${newId()}`;
const correlationId = `corr-obs-${newId()}`;
let walletId: string;
let httpTransactionId: string;
let messageId: string;

/** Linhas JSON do pino (as outras, como o "--- reiniciado ---" do teste, ficam de fora). */
function jsonLines(process: TestProcess): Record<string, unknown>[] {
  return process.lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(async () => {
  issuer = await startTestIssuer();
  queues = await createTestQueues();
  group = new ProcessGroup("s9-log-fields");
  api = await group.spawn("api", { instance: "api-logs", env: authEnv(issuer) });
  consumer = await group.spawn("consumer", {
    instance: "consumer-logs",
    env: { QUEUE_WAGER_TRANSACTIONS: queues.queueName, QUEUE_WAGER_TRANSACTIONS_DLQ: queues.dlqName },
  });
  client = apiClient(api, issuer);
  operatorToken = await issuer.operatorToken();
  providerToken = await issuer.providerToken("provider-a");

  const created = await client.request("POST", "/wallets", {
    token: operatorToken,
    body: { playerId, initialBalance: brl(INITIAL) },
  });
  expect(created.status).toBe(201);
  walletId = ((await created.json()) as { id: string }).id;
  const wallet = { id: walletId, playerId };

  const http = await submit(client, wagerBody(wallet, { money: brl(HTTP_AMOUNT) }), {
    token: providerToken,
    headers: { "x-correlation-id": correlationId },
  });
  expect(http.status).toBe(200);
  expect(http.body.balance?.amount).toBe(HTTP_BALANCE);
  httpTransactionId = http.body.transactionId;

  const message = wagerMessage(wallet, { data: { money: brl(SQS_AMOUNT) } });
  messageId = message.messageId;
  await sendMessage(queues.queueUrl, message.body, { groupId: walletId });
  await waitFor(
    () => jsonLines(consumer).some((line) => line.msg === "mensagem processada" && line.messageId === messageId),
    "consumer processou a mensagem",
  );
}, SLOW_TEST_MS);

afterAll(async () => {
  await group.close();
  await queues.destroy();
  await issuer.stop();
  await expectLedgerMatchesBalances();
});

describe("R-12-01 D11.1: campos obrigatórios nos logs", () => {
  it("R-12-01 D11.1 D22.9: fluxo HTTP → a linha de acesso tem correlationId, transactionId, walletId e providerId", () => {
    const access = jsonLines(api).find((line) => line.msg === "requisição concluída" && line.correlationId === correlationId);

    expect(access).toMatchObject({
      level: 30,
      correlationId,
      transactionId: httpTransactionId,
      walletId,
      providerId: "provider-a",
      method: "POST",
      route: "/wagering/transactions",
      status: 200,
    });
    expect(Number.isInteger(access?.durationMs)).toBe(true);
  });

  it("R-12-01 D11.1: fluxo SQS → a linha da mensagem tem os 5 campos", () => {
    const processed = jsonLines(consumer).find((line) => line.msg === "mensagem processada" && line.messageId === messageId);

    expect(processed).toMatchObject({
      correlationId: messageId,
      messageId,
      walletId,
      providerId: "provider-a",
      transactionId: expect.any(String),
    });
  });

  it("D22.9 (b): health e docs não geram linha de acesso", async () => {
    const before = jsonLines(api).filter((line) => line.msg === "requisição concluída").length;

    await fetch(`${api.baseUrl}/health/live`);
    await fetch(`${api.baseUrl}/docs-json`);
    // Uma requisição registrada depois das duas serve de marco: as linhas chegam em ordem.
    const marker = `corr-marco-${newId()}`;
    await client.request("GET", `/wallets/${walletId}`, { token: operatorToken, headers: { "x-correlation-id": marker } });
    await waitFor(() => jsonLines(api).some((line) => line.correlationId === marker), "linha do marco");

    const access = jsonLines(api).filter((line) => line.msg === "requisição concluída");
    expect(access.length).toBe(before + 1);
    expect(access.at(-1)).toMatchObject({ route: "/wallets/:walletId", walletId, status: 200 });
  });
});

describe("R-12-02 D11.1: nada sensível nos logs", () => {
  it("R-12-02 D11.1: nenhum valor, saldo, playerId ou token nas linhas da api e do consumer", () => {
    const dump = [...api.lines, ...consumer.lines].join("\n");

    for (const secret of [
      playerId,
      INITIAL,
      HTTP_AMOUNT,
      HTTP_BALANCE,
      SQS_AMOUNT,
      SQS_BALANCE,
      operatorToken,
      providerToken,
      "Bearer ",
    ]) {
      expect({ secret, found: dump.includes(secret) }).toEqual({ secret, found: false });
    }
  });
});
