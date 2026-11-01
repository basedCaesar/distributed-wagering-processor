import { describe, expect, it } from "bun:test";
import {
  type AuditableEvent,
  AuditIntegrationEventUseCase,
} from "../../../src/modules/wagering/application/audit-integration-event.use-case";
import { InboxConflictError } from "../../../src/modules/wagering/application/errors";
import { canonicalJson, envelopeHash } from "../../../src/modules/wagering/application/payload-hash";
import type {
  AuditedEventRow,
  InboxEntry,
  InboxRegistration,
  TransactionScope,
  UnitOfWork,
} from "../../../src/modules/wagering/application/ports";
import { T0 } from "../../support/wager-fixtures";

const WALLET = "0192f291-27dd-7d3f-8071-5f8685deef37";

function auditable(overrides: Partial<AuditableEvent> = {}): AuditableEvent {
  const eventId = overrides.eventId ?? "0192f2a0-0000-7000-8000-000000000001";
  const eventType = overrides.eventType ?? "WalletBalanceChanged";
  const base = {
    eventId,
    eventType,
    aggregateId: WALLET,
    occurredAt: T0,
    walletId: WALLET,
    walletVersion: 3,
    ...overrides,
  };
  return { ...base, envelope: overrides.envelope ?? { eventId, eventType, data: { walletVersion: base.walletVersion } } };
}

/**
 * Escopo em memória: a inbox devolve `registration`; `audited` guarda as
 * linhas, e a última versão é calculada sobre elas por (wallet, tipo).
 */
function fakeUow(registration: InboxRegistration, existing: AuditedEventRow[] = []) {
  const calls: string[] = [];
  const registered: InboxEntry[] = [];
  const audited: AuditedEventRow[] = [...existing];
  const scope = {
    now: async () => T0,
    inbox: {
      register: async (entry: InboxEntry) => {
        calls.push("inbox.register");
        registered.push(entry);
        return registration;
      },
    },
    auditedEvents: {
      lastWalletVersion: async (walletId: string, eventType: string) => {
        calls.push("auditedEvents.lastWalletVersion");
        const versions = audited
          .filter((row) => row.walletId === walletId && row.eventType === eventType && row.walletVersion !== undefined)
          .map((row) => row.walletVersion as number);
        return versions.length === 0 ? undefined : Math.max(...versions);
      },
      insert: async (row: AuditedEventRow) => {
        calls.push("auditedEvents.insert");
        audited.push(row);
      },
    },
  } as unknown as TransactionScope;
  const uow: UnitOfWork = {
    async run(work) {
      calls.push("BEGIN");
      return work(scope);
    },
  };
  return { uow, calls, registered, audited };
}

const row = (eventType: string, walletVersion: number): AuditedEventRow => ({
  eventId: `0192f2a0-0000-7000-8000-${String(walletVersion).padStart(12, "0")}`,
  eventType,
  aggregateId: WALLET,
  walletId: WALLET,
  walletVersion,
  inOrder: true,
  occurredAt: T0,
  auditedAt: T0,
});

describe("R-11-03 D9.7 D20.1: o use case do auditor", () => {
  it("D9.7 D20.1: inbox primeiro, depois a linha auditada, numa transação só; hash = SHA-256 do envelope canônico", async () => {
    const { uow, calls, registered, audited } = fakeUow("new");
    const event = auditable();

    const result = await new AuditIntegrationEventUseCase(uow).execute(event, "event-auditor");

    expect(result).toEqual({ kind: "audited", inOrder: true });
    expect(calls).toEqual(["BEGIN", "inbox.register", "auditedEvents.lastWalletVersion", "auditedEvents.insert"]);
    expect(registered).toEqual([
      { consumerName: "event-auditor", messageId: event.eventId, hash: envelopeHash(event.envelope) },
    ]);
    expect(audited).toEqual([
      {
        eventId: event.eventId,
        eventType: "WalletBalanceChanged",
        aggregateId: WALLET,
        walletId: WALLET,
        walletVersion: 3,
        inOrder: true,
        occurredAt: T0,
        auditedAt: T0,
      },
    ]);
  });

  it("D20.1: o hash do envelope não depende da ordem das chaves (o jsonb as reordena, D20.9)", () => {
    expect(envelopeHash({ b: 1, a: { d: 2, c: 3 } })).toBe(envelopeHash({ a: { c: 3, d: 2 }, b: 1 }));
    expect(envelopeHash({ a: 1 })).not.toBe(envelopeHash({ a: 2 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("R-11-03 D9.7: evento já auditado (mesmo eventId e hash) → duplicata, nenhuma linha nova", async () => {
    const { uow, calls, audited } = fakeUow("duplicate");

    expect(await new AuditIntegrationEventUseCase(uow).execute(auditable(), "event-auditor")).toEqual({ kind: "duplicate" });
    expect(calls).toEqual(["BEGIN", "inbox.register"]);
    expect(audited).toEqual([]);
  });

  it("D20.2: mesmo eventId com outro conteúdo → InboxConflictError (permanente, DLQ)", async () => {
    const { uow, audited } = fakeUow("conflict");

    await expect(new AuditIntegrationEventUseCase(uow).execute(auditable(), "event-auditor")).rejects.toBeInstanceOf(
      InboxConflictError,
    );
    expect(audited).toEqual([]);
  });

  it("D20.1: WagerTransactionProcessed e WalletBalanceChanged com a mesma walletVersion (mesma transação) não disparam o alarme", async () => {
    const { uow } = fakeUow("new", [row("WalletBalanceChanged", 3)]);

    const result = await new AuditIntegrationEventUseCase(uow).execute(
      auditable({ eventType: "WagerTransactionProcessed", walletVersion: 3 }),
      "event-auditor",
    );

    expect(result).toEqual({ kind: "audited", inOrder: true });
  });

  it("D20.1: WalletBalanceChanged com versão menor ou igual à última do mesmo tipo → fora de ordem, linha gravada mesmo assim", async () => {
    for (const stale of [2, 3]) {
      const { uow, audited } = fakeUow("new", [row("WalletBalanceChanged", 3)]);

      const result = await new AuditIntegrationEventUseCase(uow).execute(
        auditable({ walletVersion: stale }),
        "event-auditor",
      );

      expect(result).toEqual({ kind: "audited", inOrder: false });
      expect(audited.at(-1)).toMatchObject({ walletVersion: stale, inOrder: false });
    }
  });

  it("D20.1: versão maior que a última do mesmo tipo → em ordem", async () => {
    const { uow } = fakeUow("new", [row("WalletBalanceChanged", 3)]);

    expect(await new AuditIntegrationEventUseCase(uow).execute(auditable({ walletVersion: 4 }), "event-auditor")).toEqual({
      kind: "audited",
      inOrder: true,
    });
  });

  it("D20.1: evento sem walletVersion (ex.: rejeição) → sem checagem, in_order nulo", async () => {
    const { uow, calls, audited } = fakeUow("new");
    const { walletVersion: _, ...withoutVersion } = auditable({ eventType: "WagerTransactionRejected" });

    const result = await new AuditIntegrationEventUseCase(uow).execute(withoutVersion, "event-auditor");

    expect(result).toEqual({ kind: "audited", inOrder: null });
    expect(calls).not.toContain("auditedEvents.lastWalletVersion");
    expect(audited[0]?.inOrder).toBeNull();
  });
});
