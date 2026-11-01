import { describe, expect, it } from "bun:test";
import {
  isExpired,
  nextAttemptAt,
  PENDING_POLICY,
  reachedErrorLimit,
} from "../../../src/modules/wagering/application/pending-policy";

const T0 = new Date("2026-11-01T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe("D4.3 D18.5: política de reprocessamento das pendentes", () => {
  it("D4.3: valores decididos — prazo 15 min, backoff de 1 s até 60 s, lease 30 s, lote 10, tick 1 s, 5 erros", () => {
    expect(PENDING_POLICY).toEqual({
      deadlineMs: 15 * MINUTE,
      baseDelayMs: SECOND,
      maxDelayMs: 60 * SECOND,
      leaseMs: 30 * SECOND,
      batchSize: 10,
      tickMs: SECOND,
      maxConsecutiveErrors: 5,
    });
  });

  it("D4.3: backoff 1, 2, 4, 8, 16, 32 s e para em 60 s", () => {
    const now = at(MINUTE);
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 50].map(
      (attempts) => nextAttemptAt({ attempts, createdAt: T0, now }).getTime() - now.getTime(),
    );

    expect(delays).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60].map((s) => s * SECOND));
  });

  it("D18.5: a próxima tentativa nunca passa de created_at + 15 min", () => {
    const deadline = at(15 * MINUTE);
    const now = at(15 * MINUTE - 10 * SECOND);

    expect(nextAttemptAt({ attempts: 10, createdAt: T0, now })).toEqual(deadline);
  });

  it("D18.5: já depois do prazo (tentativa com erro), o backoff vale normalmente", () => {
    const now = at(16 * MINUTE);

    expect(nextAttemptAt({ attempts: 1, createdAt: T0, now })).toEqual(at(16 * MINUTE + SECOND));
  });

  it("R-07-21 D4.3: expira em created_at + 15 min, não antes", () => {
    expect(isExpired(T0, at(15 * MINUTE - 1))).toBe(false);
    expect(isExpired(T0, at(15 * MINUTE))).toBe(true);
  });

  it("D4.2 D18.4: só o 5º erro seguido atinge o limite", () => {
    expect([1, 2, 3, 4, 5, 6].map(reachedErrorLimit)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });
});
