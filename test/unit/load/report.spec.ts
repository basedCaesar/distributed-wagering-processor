import { describe, expect, it } from "bun:test";
import { LOAD_PLAN } from "../../../load/lib/plan";
import { formatSeconds, type LoadResult, renderReport, type StepResult } from "../../../load/lib/report";

/**
 * D26.7, R-14-O1: o relatório gerado registra ambiente, metodologia,
 * throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e outbox
 * lag, por passo e por rodada, e o veredito da correção.
 */

function step(overrides: Partial<StepResult> = {}): StepResult {
  return {
    scenario: "A",
    label: "A 50/s",
    targetRate: 50,
    durationS: 60,
    ops: 3000,
    processed: 2900,
    rejected: 90,
    replays: 0,
    transientAttempts: 12,
    gaveUp: 10,
    unexpected: 0,
    interrupted: 0,
    droppedIterations: 0,
    throughput: 49.8,
    latencyMs: { p50: 12.3, p95: 40.1, p99: 88.8, max: 210 },
    opLatencyMs: { p50: 12.5, p95: 41, p99: 1100, max: 3200 },
    lockConflicts: { lock_timeout: 12, deadlock: 0 },
    lockWait: { p50: 0.004, p95: 0.08, p99: { above: 5 } },
    retries: { submission: 1 },
    outboxLag: { max: 1.4, p95: 0.9, pendingMax: 120, drainS: 2.1 },
    ...overrides,
  };
}

function result(ok: boolean): LoadResult {
  return {
    runId: "20261107T150000",
    startedAt: "2026-11-07T15:00:00.000Z",
    finishedAt: "2026-11-07T15:30:00.000Z",
    environment: { "SO do host": "Windows 11 Pro", "CPUs da VM do Docker": "16" },
    tokenRequests: 21,
    rounds: [
      {
        round: 1,
        steps: [step(), step({ scenario: "D", label: "D fila 2000", targetRate: undefined, queueDrainS: 40.5 })],
        verdict: ok ? { ok: true, failures: [] } : { ok: false, failures: ["2 wallets com saldo negativo"] },
      },
    ],
  };
}

describe("D26.7: relatório gerado", () => {
  it("R-14-O1 D26.7: tem as seções que o §14 pede", () => {
    const md = renderReport(result(true));
    for (const section of ["Ambiente", "Metodologia", "Throughput", "p50", "p95", "p99", "Taxa de erro", "Conflitos de lock", "Outbox lag"]) {
      expect({ section, found: md.includes(section) }).toEqual({ section, found: true });
    }
    expect(md).toContain("Windows 11 Pro");
    expect(md).toContain("A 50/s");
    expect(md).toContain("D fila 2000");
  });

  it("D26.7: a taxa de erro separa 503 na 1ª tentativa, desistência e status inesperado", () => {
    const md = renderReport(result(true));
    // 10 desistências em 3000 operações → 0,33%.
    expect(md).toContain("0.33%");
  });

  it("D26.7: veredito por rodada, com as falhas listadas", () => {
    expect(renderReport(result(true))).toContain("PASSOU");
    const failed = renderReport(result(false));
    expect(failed).toContain("FALHOU");
    expect(failed).toContain("2 wallets com saldo negativo");
  });

  it("D26.11: a espera do repouso antes de cada passo aparece no relatório", () => {
    const md = renderReport({
      ...result(true),
      rounds: [{ round: 1, steps: [step({ quiesceS: 42.5 })], verdict: { ok: true, failures: [] } }],
    });
    expect(md).toContain("Repouso antes");
    expect(md).toContain("42.5 s");
  });

  it("D26.11: o motivo da espera do repouso aparece por passo (leituras que cada motivo segurou)", () => {
    const md = renderReport({
      ...result(true),
      rounds: [
        {
          round: 1,
          steps: [step({ quiesceS: 90, quiesceHolds: { "1ª leitura": 1, "sessão ativa: event-auditor": 29 } })],
          verdict: { ok: true, failures: [] },
        },
      ],
    });
    expect(md).toContain("Motivo da espera");
    expect(md).toContain("sessão ativa: event-auditor ×29");
  });

  it("D26.13: a fila do auditor antes do passo aparece como contaminação conhecida", () => {
    const md = renderReport({
      ...result(true),
      rounds: [
        {
          round: 1,
          steps: [step({ auditorBacklog: { depth: 59896, ratePerS: 17.5 } })],
          verdict: { ok: true, failures: [] },
        },
      ],
    });
    expect(md).toContain("Fila do auditor antes");
    expect(md).toContain("59896");
    expect(md).toContain("17.5/s");
    expect(md).toContain("contaminação conhecida");
  });

  it("D26.13: o relatório diz por que synchronous_commit não foi mexido", () => {
    expect(renderReport(result(true))).toContain("synchronous_commit");
  });

  it("D26.4 D22.7: a latência de processamento (buckets) aparece por passo, com o canal", () => {
    const md = renderReport({
      ...result(true),
      rounds: [
        {
          round: 1,
          steps: [step({ processing: { channel: "http", p50: 0.012, p95: 0.2, p99: { above: 10 } } })],
          verdict: { ok: true, failures: [] },
        },
      ],
    });
    expect(md).toContain("Processamento");
    expect(md).toContain("12.0 ms");
    expect(md).toContain("> 10000 ms");
  });

  it("D26.5: operações interrompidas pelo k6 no fim do passo (sem desfecho) aparecem à parte", () => {
    const md = renderReport({
      ...result(true),
      rounds: [{ round: 1, steps: [step({ interrupted: 156 })], verdict: { ok: true, failures: [] } }],
    });
    expect(md).toContain("Interrompidas (k6)");
    expect(md).toContain("| 156 |");
  });

  it("D26.6: outbox que não esvaziou no teto do passo aparece como medição, sem reprovar", () => {
    const md = renderReport({
      ...result(true),
      rounds: [
        {
          round: 1,
          steps: [step({ outboxLag: { max: 170, p95: 150, pendingMax: 4000, drainS: undefined, drainTimedOut: true } })],
          verdict: { ok: true, failures: [] },
        },
      ],
    });
    expect(md).toContain(`> ${LOAD_PLAN.drainTimeoutS} s`);
    expect(md).toContain("PASSOU");
  });

  it("D26.6 D17.7: no C, as duplicatas por camada (fast_path, lock, unique_index) aparecem no relatório", () => {
    const md = renderReport({
      ...result(true),
      rounds: [
        {
          round: 1,
          steps: [step({ scenario: "C", label: "C 50×20", duplicates: { fastPath: 120, lock: 830, uniqueIndex: 0 } })],
          verdict: { ok: true, failures: [] },
        },
      ],
    });
    expect(md).toContain("Duplicatas (C)");
    expect(md).toContain("| C 50×20 | 120 | 830 | 0 |");
  });

  it("D26.12: os cenários que rodaram aparecem no topo", () => {
    expect(renderReport({ ...result(true), scenarios: ["B"] })).toContain("Cenários: B");
  });

  it("D26.7: os pedidos de token entram no relatório (fora da medição)", () => {
    expect(renderReport(result(true))).toContain("21");
  });
});

describe("D26.4: formatação dos percentis estimados", () => {
  it("D26.4: segundos em ms; acima do maior bucket vira '> N'; sem dado vira '—'", () => {
    expect(formatSeconds(0.0042)).toBe("4.2 ms");
    expect(formatSeconds(1.5)).toBe("1500 ms");
    expect(formatSeconds({ above: 5 })).toBe("> 5000 ms");
    expect(formatSeconds(undefined)).toBe("—");
  });
});
