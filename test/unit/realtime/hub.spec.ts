import { describe, expect, it } from "bun:test";
import { type RealtimeConnection, RealtimeHub } from "../../../src/modules/realtime/application/realtime-hub";
import type { RealtimeEvent, Viewer } from "../../../src/modules/realtime/domain/realtime-event";

const W1 = "0190f5b8-0000-7000-8000-0000000000a1";
const W2 = "0190f5b8-0000-7000-8000-0000000000a2";

function connection(viewer: Viewer): RealtimeConnection & { received: RealtimeEvent[] } {
  const received: RealtimeEvent[] = [];
  return { viewer, received, deliver: (event) => received.push(event) };
}

function event(walletId: string, audience: RealtimeEvent["audience"] = { kind: "wallet" }): RealtimeEvent {
  return {
    eventId: Bun.randomUUIDv7(),
    eventType: "WalletBalanceChanged",
    occurredAt: "2026-11-08T12:00:00.000Z",
    walletId,
    walletVersion: 2,
    data: {},
    audience,
  };
}

/** Hub em que uma falha de entrega inesperada derruba o teste (não é engolida). */
function newHub(maxFollowsPerConnection = 50): RealtimeHub {
  return new RealtimeHub({
    maxFollowsPerConnection,
    onDeliveryFailure: (error) => {
      throw error;
    },
  });
}

const operator: Viewer = { roles: new Set(["operator"]) };
const providerB: Viewer = { roles: new Set(["provider"]), providerId: "provider-b" };

describe("D28.2 D28.3: hub de conexões e wallets seguidas", () => {
  it("D28.2: entrega só a quem segue a wallet do evento", () => {
    const hub = newHub();
    const a = connection(operator);
    const b = connection(operator);
    hub.follow(a, W1);
    hub.follow(b, W2);

    const delivered = hub.dispatch(event(W1));

    expect(delivered).toBe(1);
    expect([a.received.length, b.received.length]).toEqual([1, 0]);
  });

  it("D28.3: entrega só a quem pode ver (provedor de outro provedor não recebe a transação)", () => {
    const hub = newHub();
    const op = connection(operator);
    const other = connection(providerB);
    hub.follow(op, W1);
    hub.follow(other, W1);

    hub.dispatch(event(W1, { kind: "transaction", providerId: "provider-a" }));

    expect([op.received.length, other.received.length]).toEqual([1, 0]);
  });

  it("D28.2: seguir de novo não duplica; unfollow e remove param a entrega", () => {
    const hub = newHub();
    const a = connection(operator);
    expect(hub.follow(a, W1)).toBe("followed");
    expect(hub.follow(a, W1)).toBe("followed");
    hub.dispatch(event(W1));
    expect(a.received.length).toBe(1);

    hub.unfollow(a, W1);
    hub.dispatch(event(W1));
    hub.follow(a, W2);
    hub.remove(a);
    hub.dispatch(event(W2));

    expect(a.received.length).toBe(1);
    expect(hub.followerCount(W1) + hub.followerCount(W2)).toBe(0);
  });

  it("D28.2: limite de wallets por conexão → FOLLOW_LIMIT, sem seguir", () => {
    const hub = newHub(1);
    const a = connection(operator);
    expect(hub.follow(a, W1)).toBe("followed");
    expect(hub.follow(a, W2)).toBe("limit");
    expect(hub.followerCount(W2)).toBe(0);
  });

  it("D28.7: uma conexão que falha ao entregar não impede as outras, e a falha é reportada ao onDeliveryFailure", () => {
    const failures: unknown[] = [];
    const hub = new RealtimeHub({ maxFollowsPerConnection: 50, onDeliveryFailure: (error) => failures.push(error) });
    const closed = new Error("socket fechado");
    const broken: RealtimeConnection = {
      viewer: operator,
      deliver: () => {
        throw closed;
      },
    };
    const ok = connection(operator);
    hub.follow(broken, W1);
    hub.follow(ok, W1);

    expect(hub.dispatch(event(W1))).toBe(1);
    expect(ok.received.length).toBe(1);
    expect(failures).toEqual([closed]);
  });
});
