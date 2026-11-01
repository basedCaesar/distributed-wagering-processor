import { describe, expect, it } from "bun:test";
import {
  attemptsExhausted,
  backoffSeconds,
  CONSUMER_POLICY,
  dispositionOf,
} from "../../../src/modules/wagering/infra/messaging/consumer-policy";
import type { ErrorCategory } from "../../../src/shared/errors/classify-error";

describe("D8.2 D8.3 D19.6: política do consumidor", () => {
  it("D8.2: backoff de 2ⁿ s, até 300 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffSeconds(n))).toEqual([
      2, 4, 8, 16, 32, 64, 128, 256,
    ]);
    expect(backoffSeconds(9)).toBe(300);
    expect(backoffSeconds(30)).toBe(300);
  });

  it("D8.2: o teto é configurável (os testes usam 0 para reentrega imediata)", () => {
    expect(backoffSeconds(3, 0)).toBe(0);
    expect(backoffSeconds(1, 1)).toBe(1);
  });

  it("D8.3: limite de 8 tentativas; a 8ª falha manda para a DLQ", () => {
    expect(CONSUMER_POLICY.maxAttempts).toBe(8);
    expect(attemptsExhausted(7)).toBe(false);
    expect(attemptsExhausted(8)).toBe(true);
    expect(attemptsExhausted(3, 3)).toBe(true);
  });

  it("D19.6 D8.5: long poll 20 s, até 10 mensagens, visibilidade 120 s, 20 s para terminar no SIGTERM", () => {
    expect(CONSUMER_POLICY).toMatchObject({
      waitTimeSeconds: 20,
      maxMessages: 10,
      visibilityTimeoutSeconds: 120,
      shutdownGraceMs: 20_000,
      backoffMaxSeconds: 300,
    });
  });

  it("D19.9: o stop espera o long poll (20 s) e devolve o que ele trouxer; 20 s + 5 s cabem nos 30 s do Compose", () => {
    expect(CONSUMER_POLICY.waitTimeSeconds * 1000).toBeLessThanOrEqual(CONSUMER_POLICY.shutdownGraceMs);
    expect(CONSUMER_POLICY.releaseMarginMs).toBe(5_000);
    expect(CONSUMER_POLICY.shutdownGraceMs + CONSUMER_POLICY.releaseMarginMs).toBeLessThan(30_000);
  });

  it("R-10-06 D8.2 D19.1 D19.2: permanente → DLQ; transitório e interno → retry contado", () => {
    const expected: Record<ErrorCategory, "dead_letter" | "retry"> = {
      validation: "dead_letter",
      not_found: "dead_letter",
      conflict: "dead_letter",
      transient: "retry",
      internal: "retry",
      // Não acontecem na fila (sem auth, L40); um bug que os produza é tratado como interno.
      unauthenticated: "retry",
      forbidden: "retry",
    };
    for (const [category, disposition] of Object.entries(expected)) {
      expect({ category, disposition: dispositionOf(category as ErrorCategory) }).toEqual({
        category,
        disposition,
      });
    }
  });
});
