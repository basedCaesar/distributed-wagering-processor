import { describe, expect, it } from "bun:test";
import { connect as tcpConnect } from "node:net";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplicationContext } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { PendingWorkerAppModule } from "../../../src/app/pending-worker.module";
import { PendingWorker } from "../../../src/modules/wagering/infra/workers/pending-worker";
import { loadConfig } from "../../../src/shared/config/config";
import { APP_CONFIG } from "../../../src/shared/config/config.module";
import { HealthService } from "../../../src/shared/health/health.service";
import { startTestApi } from "../../support/api";
import { connect, newId, withClient } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { insertRow, transactionRow } from "../../support/db-seed";
import { waitFor } from "../../support/processes";
import { brl, createWallet, holdWalletLock, submit, waitForWalletLockWaiters, wagerBody } from "../../support/wagering";
import { parkPendings, pendingRow } from "../../support/worker";

/** O prazo de drenagem é o da requisição (D8.6, D21.3); curto no teste. */
const DRAIN_MS = 1000;

/** Registra quando o ORM começa a fechar. */
function recordOrmClose(moduleRef: Pick<TestingModule, "get">, hooks: string[]): void {
  const orm = moduleRef.get(MikroORM);
  const close = orm.close.bind(orm);
  orm.close = async (force?: boolean) => {
    hooks.push("orm.close começou");
    await close(force);
  };
}

describe("D8.6 D21.2: shutdown da api (o caminho do SIGTERM, pelo app.close())", () => {
  it("D8.6 D21.2: no shutdown, a readiness fica falsa, conexões novas são recusadas, a requisição em andamento termina 200 e só depois o ORM fecha", async () => {
    const config = loadConfig();
    const api = await startTestApi({
      overrides: [{ provide: APP_CONFIG, useValue: { ...config, http: { requestTimeoutMs: 5000 } } }],
    });
    const hooks: string[] = [];
    recordOrmClose(api.app, hooks);
    const wallet = await createWallet(api, brl("100.00"));
    const lock = await holdWalletLock(wallet.id);
    const observer = await connect("app");
    let closing: Promise<void> | undefined;
    try {
      const inFlight = submit(api, wagerBody(wallet, { money: brl("10.00") })).then((response) => {
        hooks.push("requisição em andamento terminou");
        return response;
      });
      await waitForWalletLockWaiters(observer, lock, 1);

      closing = api.close();
      const health = api.app.get(HealthService);
      await waitFor(() => health.isShuttingDown(), "a readiness ficar falsa", 1000);
      expect((await health.checkReady()).ready).toBe(false);
      // O servidor parou de aceitar: uma conexão nova é recusada.
      await waitFor(
        () =>
          fetch(`${api.baseUrl}/health/live`, { headers: { connection: "close" } }).then(
            () => false,
            () => true,
          ),
        "o servidor recusar conexões novas",
        1000,
      );

      await lock.release();
      const response = await inFlight;
      expect(response.status).toBe(200);
      await closing;
      closing = undefined;
    } finally {
      await lock.release();
      await observer.end();
      await closing;
    }
    expect(hooks).toEqual(["requisição em andamento terminou", "orm.close começou"]);
    await expectLedgerMatchesBalances();
  });

  it("D8.6 D21.3: uma conexão presa (requisição incompleta) não segura o shutdown além do prazo da requisição", async () => {
    const config = loadConfig();
    const api = await startTestApi({
      overrides: [{ provide: APP_CONFIG, useValue: { ...config, http: { requestTimeoutMs: DRAIN_MS } } }],
    });
    const { port } = new URL(api.baseUrl);
    const socket = tcpConnect(Number(port), "127.0.0.1");
    const socketClosed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    // Cabeçalhos sem o fim: o servidor fica esperando o resto.
    socket.write("POST /wallets HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{");

    const started = performance.now();
    await api.close();
    const elapsed = performance.now() - started;
    await socketClosed;
    expect(elapsed).toBeLessThan(DRAIN_MS + 2000);
  }, 15_000);
});

describe("D7.4 D8.6 D18.8 D21.2: shutdown do pending-worker (Nest)", () => {
  it("D7.4 D8.6 D18.8: o PendingWorkerAppModule tenta a pendente vencida e, no shutdown, o stop() termina antes de o ORM fechar", async () => {
    const created: string[] = [];
    let app: INestApplicationContext | undefined;
    try {
      const pending = await withClient("app", async (client) => {
        const walletId = newId();
        const playerId = `player-${newId()}`;
        await insertRow(client, "wallets", {
          id: walletId,
          player_id: playerId,
          currency: "BRL",
          balance: "0.00",
          version: 1,
          created_at: new Date(),
          updated_at: new Date(),
        });
        const row = transactionRow(
          { id: walletId, playerId, currency: "BRL" },
          {
            kind: "REFUND",
            reference_external_transaction_id: `missing-${newId()}`,
            status: "PENDING_REFERENCE",
            balance_after: null,
            balance_after_currency: null,
            processed_at: null,
            next_attempt_at: new Date(),
            correlation_id: `corr-${newId()}`,
          },
        );
        await insertRow(client, "wager_transactions", row);
        created.push(row.id);
        return row.id;
      });
      const moduleRef = await Test.createTestingModule({ imports: [PendingWorkerAppModule] }).compile();
      const worker = moduleRef.get(PendingWorker);
      const hooks: string[] = [];
      const stop = worker.stop.bind(worker);
      worker.stop = async () => {
        await stop();
        hooks.push("stop terminou");
      };
      recordOrmClose(moduleRef, hooks);
      app = await moduleRef.init();

      worker.start();
      await waitFor(async () => (await pendingRow(pending)).attempts >= 1, "o worker tentar a pendente", 20_000);
      await app.close();
      app = undefined;

      expect(hooks).toEqual(["stop terminou", "orm.close começou"]);
    } finally {
      await app?.close();
      await withClient("app", (client) => parkPendings(client, created));
    }
  }, 30_000);
});
