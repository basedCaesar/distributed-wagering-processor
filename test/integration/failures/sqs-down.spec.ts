import { afterEach, describe, expect, it } from "bun:test";
import { loadConfig } from "../../../src/shared/config/config";
import { APP_CONFIG } from "../../../src/shared/config/config.module";
import { startTestApi, type TestApi } from "../../support/api";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { freePort } from "../../support/processes";
import { brl, createWallet, submit, wagerBody } from "../../support/wagering";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.close();
  api = undefined;
});

describe("D5 B7.7 D21.7: a API não depende do SQS", () => {
  it("D5 B7.7 D21.7 F2: com o SQS fora, a submissão responde 200 (o evento fica na outbox) e a readiness 503", async () => {
    const config = loadConfig();
    // Porta sem serviço: o SQS recusa a conexão na hora.
    const sqsDown = { ...config, aws: { ...config.aws, endpoint: `http://127.0.0.1:${await freePort()}` } };
    api = await startTestApi({ overrides: [{ provide: APP_CONFIG, useValue: sqsDown }] });

    const wallet = await createWallet(api, brl("100.00"));
    const response = await submit(api, wagerBody(wallet, { money: brl("10.00") }));
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("PROCESSED");

    const ready = await fetch(`${api.baseUrl}/health/ready`);
    expect(ready.status).toBe(503);
    const body = (await ready.json()) as { postgres: { status: string }; sqs: { status: string } };
    expect(body.postgres.status).toBe("ok");
    expect(body.sqs.status).not.toBe("ok");
    await expectLedgerMatchesBalances();
  });
});
