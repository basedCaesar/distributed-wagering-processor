import { describe, expect, it } from "bun:test";
import {
  auditorDrainRate,
  auditorWindow,
  completedOperations,
  isQuiet,
  notQuietReasons,
  summarizeHolds,
} from "../../../load/lib/quiesce";
import { parsePrometheus } from "../../../load/lib/prometheus";

/**
 * D26.11: antes de cada passo, o orquestrador espera o sistema voltar ao
 * repouso, para um passo não herdar a carga do anterior: outbox vazia,
 * nenhuma sessão da app ativa no banco e nenhuma operação concluída entre
 * duas leituras seguidas do `/metrics`.
 */

describe("D26.11: repouso entre passos", () => {
  const quiet = { outboxPending: 0, activeByProcess: {}, completed: 120 };

  it("D26.11: outbox vazia, nenhuma sessão ativa e contagem igual à leitura anterior → repouso", () => {
    expect(isQuiet(quiet, { ...quiet })).toBe(true);
  });

  it("D26.11: a primeira leitura nunca basta (precisa de duas iguais)", () => {
    expect(isQuiet(undefined, quiet)).toBe(false);
  });

  it("D26.11: outbox com pendentes, sessão ativa ou operação concluída entre as leituras → ainda não", () => {
    expect(isQuiet(quiet, { ...quiet, outboxPending: 1 })).toBe(false);
    expect(isQuiet(quiet, { ...quiet, activeByProcess: { "outbox-publisher": 1 } })).toBe(false);
    expect(isQuiet(quiet, { ...quiet, completed: 121 })).toBe(false);
  });

  it("D26.11: duas leituras iguais com as instâncias em ordem diferente → mesma contagem e repouso", () => {
    // O `_sum` tem casas decimais e, somado em outra ordem, muda na última casa; o detector só usa os `_count`.
    const api = parsePrometheus(
      'wagering_processing_duration_seconds_count{channel="http",outcome="ok"} 21097\n' +
        'wagering_processing_duration_seconds_sum{channel="http",outcome="ok"} 10255.389364900995\n',
    );
    const consumer = parsePrometheus(
      'wagering_processing_duration_seconds_count{channel="sqs",outcome="ok"} 662\n' +
        'wagering_processing_duration_seconds_sum{channel="sqs",outcome="ok"} 0.1\n',
    );
    const worker = parsePrometheus('wagering_processing_duration_seconds_sum{channel="worker",outcome="ok"} 0.2\n');
    const first = { outboxPending: 0, activeByProcess: {}, completed: completedOperations([api, consumer, worker]) };
    const second = { outboxPending: 0, activeByProcess: {}, completed: completedOperations([worker, consumer, api]) };
    expect(second.completed).toBe(first.completed);
    expect(isQuiet(first, second)).toBe(true);
  });

  it("D26.11: o motivo de cada leitura fora do repouso, por condição e por processo", () => {
    expect(notQuietReasons(undefined, quiet)).toEqual([{ reason: "1ª leitura", detail: "1ª leitura" }]);
    expect(notQuietReasons(quiet, { ...quiet })).toEqual([]);
    expect(
      notQuietReasons(quiet, {
        outboxPending: 7,
        activeByProcess: { "pending-worker": 1, "api-2": 2, consumer: 0 },
        completed: 125,
      }),
    ).toEqual([
      { reason: "outbox com pendentes", detail: "outbox: 7 pendentes" },
      { reason: "sessão ativa: api-2", detail: "sessão ativa: api-2 (2)" },
      { reason: "sessão ativa: pending-worker", detail: "sessão ativa: pending-worker (1)" },
      { reason: "operações concluídas", detail: "operações concluídas: +5" },
    ]);
  });

  it("D26.11: o event-auditor fica fora do repouso (o atraso dele é registrado à parte)", () => {
    expect(isQuiet(quiet, { ...quiet, activeByProcess: { "event-auditor": 3 } })).toBe(true);
    expect(notQuietReasons(quiet, { ...quiet, activeByProcess: { "event-auditor": 3, "api-1": 1 } })).toEqual([
      { reason: "sessão ativa: api-1", detail: "sessão ativa: api-1 (1)" },
    ]);
  });

  it("D26.13: vazão do auditor = mensagens consumidas da fila dele por segundo entre duas leituras", () => {
    expect(auditorDrainRate({ depth: 60246, atMs: 0 }, { depth: 59896, atMs: 20_000 })).toBeCloseTo(17.5, 5);
    // Fila vazia nas duas: não há o que medir.
    expect(auditorDrainRate({ depth: 0, atMs: 0 }, { depth: 0, atMs: 20_000 })).toBeUndefined();
    // Intervalo curto demais: a leitura não vale.
    expect(auditorDrainRate({ depth: 100, atMs: 0 }, { depth: 90, atMs: 500 })).toBeUndefined();
  });

  it("D26.13: a janela da vazão do auditor só começa com a outbox vazia, e recomeça se ela voltar a ter pendentes", () => {
    const reading = { depth: 500, atMs: 0 };
    expect(auditorWindow(undefined, 5)).toBe("wait");
    expect(auditorWindow(undefined, 0)).toBe("start");
    expect(auditorWindow(reading, 0)).toBe("keep");
    expect(auditorWindow(reading, 3)).toBe("wait");
  });

  it("D26.11: resumo do passo: quantas leituras cada motivo segurou", () => {
    expect(
      summarizeHolds([
        [{ reason: "1ª leitura", detail: "1ª leitura" }],
        [{ reason: "sessão ativa: event-auditor", detail: "sessão ativa: event-auditor (1)" }],
        [
          { reason: "sessão ativa: event-auditor", detail: "sessão ativa: event-auditor (2)" },
          { reason: "outbox com pendentes", detail: "outbox: 3 pendentes" },
        ],
        [],
      ]),
    ).toEqual({ "1ª leitura": 1, "sessão ativa: event-auditor": 2, "outbox com pendentes": 1 });
  });

  it("D26.11 D22.7: operações concluídas = soma dos _count da latência de processamento, em todas as instâncias", () => {
    const api = parsePrometheus(
      'wagering_processing_duration_seconds_count{channel="http",outcome="ok"} 10\n' +
        'wagering_processing_duration_seconds_count{channel="http",outcome="error"} 2\n' +
        'wagering_processing_duration_seconds_sum{channel="http",outcome="ok"} 1.5\n',
    );
    const consumer = parsePrometheus('wagering_processing_duration_seconds_count{channel="sqs",outcome="ok"} 5\n');
    expect(completedOperations([api, consumer])).toBe(17);
  });
});
