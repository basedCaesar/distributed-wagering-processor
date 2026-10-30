import { describe, expect, it } from "bun:test";
import {
  getContext,
  runWithContext,
} from "../../src/shared/logger/request-context";

describe("S0 D11.1: contexto de log via AsyncLocalStorage", () => {
  it("D11.1: dentro de runWithContext, getContext() devolve o contexto definido", () => {
    runWithContext({ correlationId: "corr-1" }, () => {
      expect(getContext()).toEqual({ correlationId: "corr-1" });
    });
  });

  it("D11.1: fora de runWithContext, getContext() devolve undefined", () => {
    expect(getContext()).toBeUndefined();
  });

  it("D11.1: contextos aninhados não se misturam entre chamadas concorrentes", async () => {
    const results = await Promise.all([
      runWithContext({ correlationId: "a" }, async () => {
        await Promise.resolve();
        return getContext()?.correlationId;
      }),
      runWithContext({ correlationId: "b" }, async () => {
        await Promise.resolve();
        return getContext()?.correlationId;
      }),
    ]);

    expect(results).toEqual(["a", "b"]);
  });
});
