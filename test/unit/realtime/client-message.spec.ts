import { describe, expect, it } from "bun:test";
import { parseClientMessage } from "../../../src/modules/realtime/infra/ws/client-message";
import { ValidationError } from "../../../src/shared/errors/app-errors";

const WALLET = "0190f5b8-0000-7000-8000-000000000001";

describe("D28.2: frames do cliente", () => {
  it("D28.2: auth, follow e unfollow", () => {
    expect(parseClientMessage(JSON.stringify({ type: "auth", token: "abc.def.ghi" }))).toEqual({
      type: "auth",
      token: "abc.def.ghi",
    });
    expect(parseClientMessage(JSON.stringify({ type: "follow", walletId: WALLET }))).toEqual({
      type: "follow",
      walletId: WALLET,
    });
    expect(parseClientMessage(JSON.stringify({ type: "unfollow", walletId: WALLET }))).toEqual({
      type: "unfollow",
      walletId: WALLET,
    });
  });

  it.each([
    ["JSON quebrado", "{"],
    ["sem type", JSON.stringify({ token: "x" })],
    ["type desconhecido", JSON.stringify({ type: "subscribe", walletId: WALLET })],
    ["walletId que não é UUID", JSON.stringify({ type: "follow", walletId: "wallet-1" })],
    ["token vazio", JSON.stringify({ type: "auth", token: "" })],
    ["array", "[]"],
  ])("D28.2: %s → ValidationError", (_, raw) => {
    expect(() => parseClientMessage(raw)).toThrow(ValidationError);
  });

  it("D28.2 D11.1: a mensagem do erro nunca traz o token", () => {
    try {
      parseClientMessage(JSON.stringify({ type: "auth", token: 42, extra: "segredo-do-token" }));
      throw new Error("deveria falhar");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(JSON.stringify(error) + String(error)).not.toContain("segredo-do-token");
    }
  });
});
