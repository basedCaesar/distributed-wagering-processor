import { describe, expect, it } from "bun:test";
import { canSee, type RealtimeEvent, type Viewer } from "../../../src/modules/realtime/domain/realtime-event";

const operator: Viewer = { roles: new Set(["operator"]) };
const providerA: Viewer = { roles: new Set(["provider"]), providerId: "provider-a" };
const providerB: Viewer = { roles: new Set(["provider"]), providerId: "provider-b" };
const both: Viewer = { roles: new Set(["provider", "operator"]), providerId: "provider-a" };

function event(audience: RealtimeEvent["audience"]): RealtimeEvent {
  return {
    eventId: "e",
    eventType: "X",
    occurredAt: "2026-11-08T12:00:00.000Z",
    walletId: "w",
    walletVersion: null,
    data: {},
    audience,
  };
}

describe("D28.3 D10.2: quem vê cada evento", () => {
  it("D28.3: evento da wallet → provedor e operador", () => {
    const wallet = event({ kind: "wallet" });
    expect([operator, providerA, providerB].map((viewer) => canSee(viewer, wallet))).toEqual([true, true, true]);
  });

  it("D28.3 D10.2: evento de transação → o operador e só o provedor dela", () => {
    const tx = event({ kind: "transaction", providerId: "provider-a" });
    expect([operator, providerA, providerB].map((viewer) => canSee(viewer, tx))).toEqual([true, true, false]);
  });

  it("D28.3: OPENING (providerId nulo) → só o operador", () => {
    const opening = event({ kind: "transaction", providerId: null });
    expect([operator, providerA, providerB].map((viewer) => canSee(viewer, opening))).toEqual([true, false, false]);
  });

  it("D28.3 D16.10: token com os dois papéis soma as permissões", () => {
    expect(canSee(both, event({ kind: "transaction", providerId: "provider-b" }))).toBe(true);
  });
});
