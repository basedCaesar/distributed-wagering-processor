import { describe, expect, it } from "bun:test";
import {
  ConfigValidationError,
  loadConfig,
} from "../../src/shared/config/config";

const baseEnv = {
  PORT: "3000",
  AWS_REGION: "us-east-1",
  AWS_ENDPOINT: "http://localhost:4566",
  SNS_TOPIC_WAGERING_EVENTS: "wagering-events.fifo",
  QUEUE_WAGER_TRANSACTIONS: "wager-transactions.fifo",
  QUEUE_WAGER_TRANSACTIONS_DLQ: "wager-transactions-dlq.fifo",
  QUEUE_WAGERING_EVENTS_AUDITOR: "wagering-events-auditor.fifo",
  QUEUE_WAGERING_EVENTS_AUDITOR_DLQ: "wagering-events-auditor-dlq.fifo",
};

describe("S0: configuração validada com zod", () => {
  it("D2.5: usa BRL e USD como lista de moedas padrão quando CURRENCIES não é definida", () => {
    const config = loadConfig(baseEnv);

    expect(config.currencies).toEqual(["BRL", "USD"]);
  });

  it("D2.5: CURRENCIES aceita lista separada por vírgula e normaliza para maiúsculas", () => {
    const config = loadConfig({ ...baseEnv, CURRENCIES: "brl,usd,eur" });

    expect(config.currencies).toEqual(["BRL", "USD", "EUR"]);
  });

  it("D2.5: código de moeda fora do formato de 3 letras falha a validação do config", () => {
    expect(() => loadConfig({ ...baseEnv, CURRENCIES: "BRLL" })).toThrow(
      ConfigValidationError,
    );
  });

  it("D2.5: lista de moedas vazia falha a validação do config", () => {
    expect(() => loadConfig({ ...baseEnv, CURRENCIES: "" })).toThrow(
      ConfigValidationError,
    );
  });

  it("S0: PORT ausente falha a validação do config", () => {
    const { PORT, ...withoutPort } = baseEnv;
    expect(() => loadConfig(withoutPort)).toThrow(ConfigValidationError);
  });

  it("S0: healthCheckTimeoutMs tem padrão de 1000ms (D11.3)", () => {
    const config = loadConfig(baseEnv);

    expect(config.healthCheckTimeoutMs).toBe(1000);
  });
});

describe("S7 D20.2 D20.5: config do publisher e do auditor", () => {
  it("D20.5: lease de 30 s e timeout do SNS de 10 s por padrão", () => {
    expect(loadConfig(baseEnv).outbox).toEqual({ leaseMs: 30_000, snsRequestTimeoutMs: 10_000 });
  });

  it("D20.5: timeout do SNS igual ou maior que o lease → a subida falha", () => {
    expect(() =>
      loadConfig({ ...baseEnv, OUTBOX_LEASE_MS: "10000", OUTBOX_SNS_REQUEST_TIMEOUT_MS: "10000" }),
    ).toThrow(ConfigValidationError);
    expect(() => loadConfig({ ...baseEnv, OUTBOX_SNS_REQUEST_TIMEOUT_MS: "45000" })).toThrow(
      ConfigValidationError,
    );
  });

  it("D20.5: timeout menor que o lease é aceito", () => {
    const config = loadConfig({ ...baseEnv, OUTBOX_LEASE_MS: "20000", OUTBOX_SNS_REQUEST_TIMEOUT_MS: "5000" });

    expect(config.outbox).toEqual({ leaseMs: 20_000, snsRequestTimeoutMs: 5_000 });
  });

  it("D20.2: a DLQ do auditor é obrigatória", () => {
    const { QUEUE_WAGERING_EVENTS_AUDITOR_DLQ, ...without } = baseEnv;
    expect(() => loadConfig(without)).toThrow(ConfigValidationError);
    expect(loadConfig(baseEnv).aws.queues.wageringEventsAuditorDlq).toBe("wagering-events-auditor-dlq.fifo");
  });
});
