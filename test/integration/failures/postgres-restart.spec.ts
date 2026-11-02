import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ErrorBody, WalletBody } from "../../support/api";
import { startTestIssuer, type TestIssuer } from "../../support/auth";
import { wagerMessage } from "../../support/consumer";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { type OwnPostgres, startOwnPostgres } from "../../support/own-postgres";
import { apiClient, authEnv, ProcessGroup, type TestProcess, waitFor } from "../../support/processes";
import { createTestQueues, queueCounts, sendMessage, type TestQueues } from "../../support/sqs";
import { type ApiClient, brl, createWallet, type SubmissionInput, submit, wagerBody } from "../../support/wagering";

/** Um container de Postgres subindo do zero, mais dois processos Bun. */
const SETUP_MS = 120_000;
const SLOW_TEST_MS = 90_000;

let own: OwnPostgres | undefined;
let issuer: TestIssuer;
let queues: TestQueues;
let group: ProcessGroup;
let apiProcess: TestProcess;
let consumerProcess: TestProcess;
let api: ApiClient;

beforeAll(async () => {
  issuer = await startTestIssuer();
  queues = await createTestQueues();
  group = new ProcessGroup("f1-f3-postgres-proprio");
  own = await startOwnPostgres();
  const env = {
    ...own.env,
    ...authEnv(issuer),
    QUEUE_WAGER_TRANSACTIONS: queues.queueName,
    QUEUE_WAGER_TRANSACTIONS_DLQ: queues.dlqName,
  };
  [apiProcess, consumerProcess] = await Promise.all([
    group.spawn("api", { instance: "api-own", env }),
    group.spawn("consumer", { instance: "consumer-own", env }),
  ]);
  api = apiClient(apiProcess, issuer);
}, SETUP_MS);

afterAll(async () => {
  try {
    await group?.close();
    await queues?.destroy();
    await issuer?.stop();
  } finally {
    // D21.7: o container é só deste teste e sai sempre, mesmo se o teste quebrar.
    await own?.destroy();
  }
}, SETUP_MS);

/** O processo continua o mesmo: não saiu nem foi reiniciado. */
async function stillRunning(process: TestProcess): Promise<boolean> {
  return Promise.race([process.exited.then(() => false), Promise.resolve(true)]);
}

/** Reenvia com a mesma key enquanto a resposta for `503` (o provedor, D16.3). */
async function submitUntilSettled(body: SubmissionInput): Promise<Awaited<ReturnType<typeof submit>>> {
  let response = await submit(api, body);
  await waitFor(
    async () => {
      if (response.status !== 503) return true;
      response = await submit(api, body);
      return response.status !== 503;
    },
    "a submissão sair do 503",
    30_000,
  );
  return response;
}

async function balanceOf(walletId: string): Promise<WalletBody["balance"]> {
  return ((await (await api.request("GET", `/wallets/${walletId}`)).json()) as WalletBody).balance;
}

describe("D5 D21.7: falhas do Postgres com os processos de pé (Postgres próprio do teste)", () => {
  it("D5 D16.3 D21.7 F1: Postgres inalcançável → a api responde 503 TEMPORARILY_UNAVAILABLE com Retry-After: 1; nada gravado; de volta, a mesma key processa", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const body = wagerBody(wallet, { money: brl("10.00") });

    await own?.stop();
    let down: Awaited<ReturnType<typeof submit>>;
    try {
      down = await submit(api, body);
    } finally {
      await own?.start();
    }
    expect(down.status).toBe(503);
    expect(down.headers.get("retry-after")).toBe("1");
    expect((down.body as unknown as ErrorBody).error.code).toBe("TEMPORARILY_UNAVAILABLE");

    const back = await submitUntilSettled(body);
    expect(back.status).toBe(200);
    // Nada foi gravado no 503: a volta é a primeira aplicação, não um replay.
    expect(back.body.idempotentReplay).toBe(false);
    expect(await balanceOf(wallet.id)).toEqual(brl("90.00"));
    expect(await stillRunning(apiProcess)).toBe(true);
    await expectLedgerMatchesBalances(own?.credentials("app"));
  }, SLOW_TEST_MS);

  it("R-13-I6 D21.7 F3: Postgres reiniciado → a api e o consumer voltam sozinhos, sem reiniciar o processo; consistência verificada pela reconciliação", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    expect((await submit(api, wagerBody(wallet, { money: brl("10.00") }))).status).toBe(200);

    await own?.restart();

    // HTTP: o pool troca as conexões mortas; no pior caso, um 503 e o reenvio.
    expect((await submitUntilSettled(wagerBody(wallet, { money: brl("10.00") }))).status).toBe(200);
    // Fila: o consumer volta a processar depois do reinício.
    const message = wagerMessage(wallet, { data: { money: brl("10.00") } });
    await sendMessage(queues.queueUrl, message.body, { groupId: wallet.id });
    await waitFor(
      async () => {
        const counts = await queueCounts(queues.queueUrl);
        return counts.visible + counts.inFlight === 0;
      },
      "a mensagem enviada depois do reinício processada",
      60_000,
    );

    expect(await balanceOf(wallet.id)).toEqual(brl("70.00"));
    const reconciliation = await api.request("POST", `/wallets/${wallet.id}/reconciliation`);
    expect(reconciliation.status).toBe(200);
    expect(((await reconciliation.json()) as { consistent: boolean }).consistent).toBe(true);
    expect((await queueCounts(queues.dlqUrl)).visible).toBe(0);
    expect(await stillRunning(apiProcess)).toBe(true);
    expect(await stillRunning(consumerProcess)).toBe(true);
    await expectLedgerMatchesBalances(own?.credentials("app"));
  }, SLOW_TEST_MS);
});
