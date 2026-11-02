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

describe("S8 D21: config das instâncias e dos prazos", () => {
  it("D5 D21.3: prazo da requisição HTTP de 10 s por padrão", () => {
    expect(loadConfig(baseEnv).http).toEqual({ requestTimeoutMs: 10_000 });
  });

  it("D21.3: HTTP_REQUEST_TIMEOUT_MS configurável", () => {
    expect(loadConfig({ ...baseEnv, HTTP_REQUEST_TIMEOUT_MS: "1000" }).http).toEqual({ requestTimeoutMs: 1_000 });
  });

  it("D21.6 D18.2: worker de pendentes com lease de 30 s e lote de 10 por padrão (os valores de hoje)", () => {
    expect(loadConfig(baseEnv).pending).toEqual({ leaseMs: 30_000, batchSize: 10 });
  });

  it("D21.6 D19.6: consumidor com visibilidade de 120 s e 10 mensagens por receive por padrão (os valores de hoje)", () => {
    expect(loadConfig(baseEnv).consumer).toEqual({ visibilityTimeoutSeconds: 120, maxMessages: 10 });
  });

  it("D21.6 D18.2: lease que não cobre lote × lock_timeout (2 s) → a subida falha", () => {
    expect(() => loadConfig({ ...baseEnv, PENDING_LEASE_MS: "20000" })).toThrow(ConfigValidationError);
    expect(() => loadConfig({ ...baseEnv, PENDING_LEASE_MS: "5000", PENDING_BATCH_SIZE: "3" })).toThrow(
      ConfigValidationError,
    );
  });

  it("D21.6 D18.2: lease curto com lote pequeno é aceito", () => {
    expect(loadConfig({ ...baseEnv, PENDING_LEASE_MS: "5000", PENDING_BATCH_SIZE: "2" }).pending).toEqual({
      leaseMs: 5_000,
      batchSize: 2,
    });
  });

  it("D21.6 D19.6: visibilidade menor que mensagens × (2 s + 5 s) → a subida falha", () => {
    expect(() => loadConfig({ ...baseEnv, CONSUMER_VISIBILITY_TIMEOUT_S: "60" })).toThrow(ConfigValidationError);
    expect(() =>
      loadConfig({ ...baseEnv, CONSUMER_VISIBILITY_TIMEOUT_S: "10", CONSUMER_MAX_MESSAGES: "2" }),
    ).toThrow(ConfigValidationError);
  });

  it("D21.6 D19.6: visibilidade curta com uma mensagem por receive é aceita; mais de 10 por receive, não (limite do SQS)", () => {
    expect(
      loadConfig({ ...baseEnv, CONSUMER_VISIBILITY_TIMEOUT_S: "10", CONSUMER_MAX_MESSAGES: "1" }).consumer,
    ).toEqual({ visibilityTimeoutSeconds: 10, maxMessages: 1 });
    expect(() =>
      loadConfig({ ...baseEnv, CONSUMER_VISIBILITY_TIMEOUT_S: "300", CONSUMER_MAX_MESSAGES: "11" }),
    ).toThrow(ConfigValidationError);
  });

  it("D21.1: DB_APPLICATION_NAME é opcional e, quando vem, segue o formato da D6.4 (até 63 caracteres)", () => {
    expect(loadConfig(baseEnv).dbApplicationName).toBeUndefined();
    expect(loadConfig({ ...baseEnv, DB_APPLICATION_NAME: "api-2" }).dbApplicationName).toBe("api-2");
    expect(() => loadConfig({ ...baseEnv, DB_APPLICATION_NAME: "api 2" })).toThrow(ConfigValidationError);
    expect(() => loadConfig({ ...baseEnv, DB_APPLICATION_NAME: "a".repeat(64) })).toThrow(ConfigValidationError);
  });
});
