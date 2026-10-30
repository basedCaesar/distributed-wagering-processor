import { describe, expect, it } from "bun:test";

describe("S0", () => {
  it("S0: teste trivial verde — primeiro teste real de concorrência entra em S5/S8", () => {
    expect(1 + 1).toBe(2);
  });
});
