import { describe, expect, it } from "bun:test";
import { classifySubmission, retryAfterSeconds } from "../../../load/lib/classify";

/**
 * D26.5: cada resposta da submissão sob carga vira um desfecho. `200`
 * `PROCESSED` e `422` `REJECTED` são resultados corretos (D5); `503` é
 * transitório e o cliente reenvia com a mesma key; qualquer outra coisa é
 * status inesperado e reprova o `test:load` (D26.6).
 */

describe("D26.5: classificação da resposta da submissão", () => {
  it("D26.5 D5: 200 PROCESSED → processed, com o idempotentReplay da resposta", () => {
    expect(classifySubmission(200, { status: "PROCESSED", idempotentReplay: false })).toEqual({
      outcome: "processed",
      replay: false,
    });
    expect(classifySubmission(200, { status: "PROCESSED", idempotentReplay: true })).toEqual({
      outcome: "processed",
      replay: true,
    });
  });

  it("D26.5 D5: 422 REJECTED com failureCode → rejected, com o código", () => {
    expect(
      classifySubmission(422, { status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", idempotentReplay: false }),
    ).toEqual({ outcome: "rejected", replay: false, failureCode: "INSUFFICIENT_FUNDS" });
  });

  it("D26.5 D5: 503 → transient, qualquer que seja o corpo", () => {
    expect(classifySubmission(503, { error: { code: "TEMPORARILY_UNAVAILABLE" } })).toEqual({ outcome: "transient" });
    expect(classifySubmission(503, undefined)).toEqual({ outcome: "transient" });
  });

  it("D26.5: status fora da tabela da carga → unexpected, com o código de erro do corpo", () => {
    expect(classifySubmission(500, { error: { code: "INTERNAL_ERROR" } })).toEqual({
      outcome: "unexpected",
      errorCode: "INTERNAL_ERROR",
    });
    expect(classifySubmission(409, { error: { code: "IDEMPOTENCY_KEY_CONFLICT" } })).toEqual({
      outcome: "unexpected",
      errorCode: "IDEMPOTENCY_KEY_CONFLICT",
    });
    // A carga não manda referência: 202 PENDING_REFERENCE seria um bug do cenário ou da API.
    expect(classifySubmission(202, { status: "PENDING_REFERENCE", idempotentReplay: false })).toEqual({
      outcome: "unexpected",
    });
    for (const status of [400, 401, 403, 404, 504, 0]) {
      expect(classifySubmission(status, undefined).outcome).toBe("unexpected");
    }
  });

  it("D26.5: 200 ou 422 com corpo que não bate com o status → unexpected", () => {
    expect(classifySubmission(200, { status: "REJECTED", idempotentReplay: false }).outcome).toBe("unexpected");
    expect(classifySubmission(200, { status: "PROCESSED" }).outcome).toBe("unexpected");
    expect(classifySubmission(422, { status: "REJECTED", idempotentReplay: false }).outcome).toBe("unexpected");
    expect(classifySubmission(200, undefined).outcome).toBe("unexpected");
  });
});

describe("D26.5: espera do reenvio", () => {
  it("D26.5 D5: usa o Retry-After em segundos", () => {
    expect(retryAfterSeconds("1")).toBe(1);
    expect(retryAfterSeconds("3")).toBe(3);
  });

  it("D26.5: Retry-After ausente ou inválido → 1 s; acima de 10 s → 10 s", () => {
    expect(retryAfterSeconds(undefined)).toBe(1);
    expect(retryAfterSeconds("")).toBe(1);
    expect(retryAfterSeconds("abc")).toBe(1);
    expect(retryAfterSeconds("-2")).toBe(1);
    expect(retryAfterSeconds("120")).toBe(10);
  });
});
