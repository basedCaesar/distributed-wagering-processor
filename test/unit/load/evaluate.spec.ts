import { describe, expect, it } from "bun:test";
import { evaluateRound, type RoundFacts } from "../../../load/lib/evaluate";

/**
 * D26.6: o `test:load` reprova **só** pela correção depois da carga ou por
 * status inesperado. Latência, throughput, `503` esgotado e iterações
 * descartadas pelo k6 vão para o relatório e nunca reprovam (o §14 não tem
 * meta de RPS).
 */

const STEP_A = { name: "A 50/s", ops: 3000, resolved: 2990, gaveUp: 10, unexpected: 0, dbTransactions: 2995 };
const STEP_B = { name: "B 10/s", ops: 600, resolved: 600, gaveUp: 0, unexpected: 0, dbTransactions: 600 };

/** Rodada com todos os cenários: C e D presentes. */
type FullFacts = RoundFacts & {
  duplicates: NonNullable<RoundFacts["duplicates"]>;
  queue: NonNullable<RoundFacts["queue"]>;
};

function healthy(): FullFacts {
  return {
    wallets: { expected: 320, found: 320 },
    reconciliation: { expected: 320, consistent: 320, inconsistent: [], failedCalls: 0 },
    db: {
      negativeWallets: 0,
      balanceMismatches: 0,
      processedWithoutLedger: 0,
      ledgerWithoutProcessed: 0,
      nonTerminal: 0,
      unexpectedKinds: 0,
      unexpectedRejections: 0,
    },
    steps: [{ ...STEP_A }, { ...STEP_B }],
    duplicates: {
      keys: 50,
      dbTransactions: 50,
      originalsPerKey: Array.from({ length: 50 }, () => 1),
      unexpected: 0,
      caughtAt: { lock: 900, uniqueIndex: 0 },
    },
    queue: { messages: 2000, inbox: 2000, transactions: 2000, dlqDelta: 0, unexpected: 0, drained: true },
    outboxDrained: true,
  };
}

function failuresWith(change: (facts: FullFacts) => void): string[] {
  const facts = healthy();
  change(facts);
  return evaluateRound(facts).failures;
}

describe("D26.6: veredito da rodada", () => {
  it("D26.6: rodada correta passa, mesmo com 503 esgotado (gaveUp) depois dos reenvios", () => {
    expect(evaluateRound(healthy())).toEqual({ ok: true, failures: [] });
  });

  it("D26.6 R-09-21: reconciliação com consistent: false, chamada que falhou ou wallet não reconciliada → falha", () => {
    expect(failuresWith((f) => (f.reconciliation.inconsistent = ["w-1"]))).toHaveLength(1);
    expect(failuresWith((f) => (f.reconciliation.failedCalls = 1))).toHaveLength(1);
    expect(failuresWith((f) => (f.reconciliation.consistent = 319))).toHaveLength(1);
  });

  it("D26.6: wallet criada que não está no banco → falha", () => {
    expect(failuresWith((f) => (f.wallets.found = 319))).toHaveLength(1);
  });

  it("D26.6 §14: saldo negativo, saldo ≠ transações, PROCESSED sem ledger, ledger sem PROCESSED → falha", () => {
    for (const key of [
      "negativeWallets",
      "balanceMismatches",
      "processedWithoutLedger",
      "ledgerWithoutProcessed",
      "nonTerminal",
      "unexpectedKinds",
      "unexpectedRejections",
    ] as const) {
      expect({ key, failures: failuresWith((f) => (f.db[key] = 1)).length }).toEqual({ key, failures: 1 });
    }
  });

  it("D26.6: status inesperado em qualquer passo → falha", () => {
    expect(failuresWith((f) => (f.steps[1] = { ...STEP_B, unexpected: 1 }))).toHaveLength(1);
    // O aquecimento entra na checagem como os outros passos.
    expect(failuresWith((f) => f.steps.unshift({ ...STEP_B, name: "aquecimento", unexpected: 1 }))).toEqual([
      "aquecimento: 1 respostas com status inesperado",
    ]);
    expect(failuresWith((f) => (f.duplicates.unexpected = 2))).toHaveLength(1);
  });

  it("D26.6: operação confirmada (200/422) que não está no banco, ou transações a mais que operações → falha", () => {
    expect(failuresWith((f) => (f.steps[0] = { ...STEP_A, dbTransactions: 2989 }))).toHaveLength(1);
    expect(failuresWith((f) => (f.steps[0] = { ...STEP_A, dbTransactions: 3001 }))).toHaveLength(1);
  });

  it("D26.6 R-13-C1: duplicatas: uma transação por key", () => {
    expect(failuresWith((f) => (f.duplicates.dbTransactions = 49))).toHaveLength(1);
    expect(failuresWith((f) => (f.duplicates.dbTransactions = 51))).toHaveLength(1);
  });

  it("D26.6 R-13-C1: duplicatas: exatamente uma resposta original (idempotentReplay: false) por key", () => {
    const twoOriginals = failuresWith((f) => (f.duplicates.originalsPerKey[3] = 2));
    expect(twoOriginals).toHaveLength(1);
    expect(twoOriginals[0]).toContain("3");
    const noOriginal = failuresWith((f) => (f.duplicates.originalsPerKey[7] = 0));
    expect(noOriginal).toHaveLength(1);
    expect(noOriginal[0]).toContain("7");
  });

  it("D26.6 R-13-C1: uma key com 2 originais e outra com 0 (o total continua 50) → falha nas duas", () => {
    const failures = failuresWith((f) => {
      f.duplicates.originalsPerKey[3] = 2;
      f.duplicates.originalsPerKey[7] = 0;
    });
    expect(failures).toHaveLength(2);
    expect(failures.join("\n")).toContain("3");
    expect(failures.join("\n")).toContain("7");
  });

  it("D26.6 R-13-C1: key sem nenhuma resposta registrada conta como 0 originais", () => {
    expect(failuresWith((f) => (f.duplicates.originalsPerKey = f.duplicates.originalsPerKey.slice(0, 49)))).toHaveLength(1);
  });

  it("D26.6 D17.7: duplicatas sem nenhuma pega no lock → falha (não houve disputa de verdade)", () => {
    expect(failuresWith((f) => (f.duplicates.caughtAt = { lock: 0, uniqueIndex: 0 }))).toHaveLength(1);
    // O unique_index só é registrado (vai para o relatório).
    expect(failuresWith((f) => (f.duplicates.caughtAt = { lock: 900, uniqueIndex: 2 }))).toEqual([]);
  });

  it("D26.6: fila: inbox e transações = mensagens, nada novo na DLQ, fila vazia", () => {
    expect(failuresWith((f) => (f.queue.inbox = 1999))).toHaveLength(1);
    expect(failuresWith((f) => (f.queue.transactions = 1999))).toHaveLength(1);
    expect(failuresWith((f) => (f.queue.dlqDelta = 1))).toHaveLength(1);
    expect(failuresWith((f) => (f.queue.drained = false))).toHaveLength(1);
  });

  it("D26.6: fila: envio com status inesperado tem mensagem própria, separada de 'não esvaziou'", () => {
    const unexpected = failuresWith((f) => (f.queue.unexpected = 10));
    expect(unexpected).toHaveLength(1);
    expect(unexpected[0]).toContain("inesperado");
    expect(unexpected[0]).not.toContain("esvaziou");
    const notDrained = failuresWith((f) => (f.queue.drained = false));
    expect(notDrained[0]).toContain("esvaziou");
    expect(notDrained[0]).not.toContain("inesperado");
  });

  it("D26.12: cenário que não rodou (--scenarios) não entra no veredito", () => {
    const facts: RoundFacts = { ...healthy(), duplicates: undefined, queue: undefined, steps: [] };
    expect(evaluateRound(facts)).toEqual({ ok: true, failures: [] });
  });

  it("D26.6: outbox que não esvaziou no teto → falha", () => {
    expect(failuresWith((f) => (f.outboxDrained = false))).toHaveLength(1);
  });

  it("D26.6: cada falha diz o que falhou, sem valores nem playerId", () => {
    const failures = failuresWith((f) => {
      f.db.negativeWallets = 2;
      f.queue.dlqDelta = 3;
    });
    expect(failures).toHaveLength(2);
    expect(failures.join("\n")).toContain("negativ");
    expect(failures.join("\n")).toContain("DLQ");
  });
});
