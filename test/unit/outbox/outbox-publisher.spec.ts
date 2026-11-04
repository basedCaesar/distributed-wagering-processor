import { describe, expect, it } from "bun:test";
import type { Logger } from "pino";
import { OUTBOX_POLICY } from "../../../src/modules/wagering/infra/outbox/outbox-policy";
import {
  type ClaimedEvent,
  type EventPublisher,
  OutboxPublisher,
  type OutboxStore,
} from "../../../src/modules/wagering/infra/outbox/outbox-publisher";

const T0 = new Date("2026-11-03T12:00:00.000Z");

const event = (id: string, attempts = 0): ClaimedEvent => ({
  id,
  aggregateId: `tx-${id}`,
  orderingKey: `wallet-${id}`,
  eventType: "WalletBalanceChanged",
  payload: { eventId: id, correlationId: `corr-${id}` },
  occurredAt: T0,
  attempts,
  nextAttemptAt: T0,
});

/**
 * Store em memória que registra cada chamada, na ordem. `recorded` é o
 * `attempts` que o `UPDATE` do dono devolve; por padrão, o do claim + 1.
 */
function fakeStore(claims: ClaimedEvent[][], recorded = (claimed: number) => claimed + 1) {
  const calls: string[] = [];
  const failures: { id: string; errorCode: string; backoffSeconds: number }[] = [];
  let round = 0;
  const store: OutboxStore = {
    async claimHeads(limit, leaseMs, token) {
      calls.push(`claim(${limit},${leaseMs},${token.length > 0})`);
      return claims[round++] ?? [];
    },
    async markPublished(ids) {
      calls.push(`mark(${[...ids].sort().join(",")})`);
      return [...ids];
    },
    async recordFailure(id, _token, failure) {
      calls.push(`failure(${id})`);
      failures.push({ id, ...failure });
      const claimed = claims.flat().find((e) => e.id === id);
      return recorded(claimed?.attempts ?? 0);
    },
  };
  return { store, calls, failures };
}

function fakeLogger() {
  const lines: { level: string; msg: string }[] = [];
  const at = (level: string) => (_fields: unknown, msg?: string) => {
    lines.push({ level, msg: msg ?? String(_fields) });
  };
  return {
    logger: { info: at("info"), warn: at("warn"), error: at("error"), debug: at("debug") } as unknown as Logger,
    lines,
  };
}

function publisherWith(store: OutboxStore, sns: EventPublisher, options = {}) {
  const { logger, lines } = fakeLogger();
  let stalledCount = 0;
  const publisher = new OutboxPublisher(store, sns, logger, { countStalled: () => stalledCount++ }, options);
  return { publisher, lines, stalled: () => stalledCount };
}

// Backoff e alerta são regras do `OutboxMessage`: test/unit/domain/outbox-message.spec.ts (D24.2).
describe("D9.6 D20.3: política do publisher", () => {
  it("D9.6: lote de 50, lease de 30 s; D20.3: claim vazio espera 500 ms", () => {
    expect(OUTBOX_POLICY).toMatchObject({ batchSize: 50, leaseMs: 30_000, idleMs: 500 });
  });
});

describe("R-11-02 D9.6: uma rodada do publisher", () => {
  it("D9.6: claim com lote e lease, publica e só então marca como publicado", async () => {
    const { store, calls } = fakeStore([[event("a"), event("b")]]);
    const published: string[] = [];
    const sns: EventPublisher = {
      async publish(e) {
        calls.push(`publish(${e.id})`);
        published.push(e.id);
      },
    };
    const { publisher } = publisherWith(store, sns);

    const round = await publisher.runOnce();

    expect(round).toEqual({ claimed: 2, published: ["a", "b"], failed: [] });
    expect(calls[0]).toBe("claim(50,30000,true)");
    expect(calls.indexOf("mark(a,b)")).toBeGreaterThan(calls.indexOf("publish(a)"));
    expect(calls.indexOf("mark(a,b)")).toBeGreaterThan(calls.indexOf("publish(b)"));
    expect(published.sort()).toEqual(["a", "b"]);
  });

  it("D20.4: falha ao publicar → falha gravada com o backoff da tentativa; as outras wallets são marcadas", async () => {
    const { store, calls, failures } = fakeStore([[event("ok"), event("bad", 2)]]);
    const sns: EventPublisher = {
      async publish(e) {
        if (e.id === "bad") throw Object.assign(new Error("SNS fora"), { code: "ECONNREFUSED" });
      },
    };
    const { publisher } = publisherWith(store, sns);

    const round = await publisher.runOnce();

    expect(round).toEqual({ claimed: 2, published: ["ok"], failed: ["bad"] });
    expect(calls).toContain("mark(ok)");
    // 3ª tentativa que falha (2 anteriores) → 2³ = 8 s.
    expect(failures).toEqual([{ id: "bad", errorCode: "TEMPORARILY_UNAVAILABLE", backoffSeconds: 8 }]);
  });

  it("D9.6 D20.4: depois de 20 tentativas continua tentando: falha gravada (nunca descarta), log error e métrica", async () => {
    const { store, failures } = fakeStore([[event("stuck", 19)], [event("stuck", 20)]]);
    const sns: EventPublisher = {
      async publish() {
        throw new Error("SNS recusou");
      },
    };
    const { publisher, lines, stalled: stalledCount } = publisherWith(store, sns);

    await publisher.runOnce();
    await publisher.runOnce();

    // Nada é descartado: a falha é gravada com backoff (teto de 300 s) e o evento volta.
    expect(failures.map((f) => f.backoffSeconds)).toEqual([300, 300]);
    expect(stalledCount()).toBe(2);
    expect(lines.filter((l) => l.level === "error").map((l) => l.msg)).toEqual([
      "evento da outbox sem publicar depois de 20 tentativas; continua tentando",
      "evento da outbox sem publicar depois de 20 tentativas; continua tentando",
    ]);
  });

  it("D24.4: o alerta segue o domínio (tentativas do claim + 1), não o número que o UPDATE devolve", async () => {
    // O claim diz 19 falhas (o domínio chega a 20: alerta), o UPDATE devolve 3;
    // o claim diz 5 (o domínio chega a 6: sem alerta), o UPDATE devolve 40.
    const recorded = new Map([
      [19, 3],
      [5, 40],
    ]);
    const { store } = fakeStore([[event("domain-stalled", 19)], [event("domain-ok", 5)]], (claimed) => {
      const value = recorded.get(claimed);
      if (value === undefined) throw new Error(`claim inesperado: ${claimed}`);
      return value;
    });
    const { publisher, lines, stalled: stalledCount } = publisherWith(store, {
      async publish() {
        throw new Error("SNS recusou");
      },
    });

    await publisher.runOnce();
    expect(stalledCount()).toBe(1);
    expect(lines.filter((l) => l.level === "error").map((l) => l.msg)).toEqual([
      "evento da outbox sem publicar depois de 20 tentativas; continua tentando",
    ]);

    await publisher.runOnce();
    expect(stalledCount()).toBe(1);
    expect(lines.filter((l) => l.level === "error")).toHaveLength(1);
  });

  it("D20.4: abaixo de 20 tentativas não há alerta", async () => {
    const { store } = fakeStore([[event("x", 5)]]);
    const { publisher, lines, stalled: stalledCount } = publisherWith(store, {
      async publish() {
        throw new Error("falhou");
      },
    });

    await publisher.runOnce();

    expect(stalledCount()).toBe(0);
    expect(lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("R-05-04: nada publicado, nada marcado num claim vazio", async () => {
    const { store, calls } = fakeStore([[]]);
    const { publisher } = publisherWith(store, {
      async publish() {
        throw new Error("não deveria publicar");
      },
    });

    expect(await publisher.runOnce()).toEqual({ claimed: 0, published: [], failed: [] });
    expect(calls).toEqual(["claim(50,30000,true)"]);
  });
});

describe("D8.6 D20.3: o laço do publisher", () => {
  it("D20.3: claim vazio → espera o idle; o stop() interrompe a espera na hora", async () => {
    const { store } = fakeStore([]);
    let claims = 0;
    let claimed: (() => void) | undefined;
    const firstClaim = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const counting: OutboxStore = {
      ...store,
      async claimHeads(...args) {
        claims++;
        claimed?.();
        return store.claimHeads(...args);
      },
    };
    // Espera de 60 s: só o stop() a termina dentro do prazo do teste.
    const { publisher } = publisherWith(counting, { publish: async () => {} }, { idleMs: 60_000 });

    publisher.start();
    await firstClaim;
    const started = Date.now();
    await publisher.stop();

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(claims).toBe(1);
  });
});
