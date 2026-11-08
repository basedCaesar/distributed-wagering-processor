/**
 * Veredito de uma rodada do `test:load` (D26.6): reprova **só** pela correção
 * depois da carga ou por status inesperado. Latência, throughput, `503`
 * esgotado e iterações descartadas pelo k6 não entram aqui: vão para o
 * relatório (o §14 não tem meta de RPS).
 */

export interface RoundFacts {
  /** Wallets criadas pela rodada × encontradas no banco. */
  wallets: { expected: number; found: number };
  /** `POST /wallets/:id/reconciliation` em todas as wallets da rodada (D21.5). */
  reconciliation: { expected: number; consistent: number; inconsistent: string[]; failedCalls: number };
  /** Consultas no banco, só sobre as wallets da rodada. Cada número é uma contagem de violações. */
  db: {
    negativeWallets: number;
    /** Saldo ≠ soma das transações `PROCESSED` (OPENING e WIN creditam, BET debita). */
    balanceMismatches: number;
    /** `PROCESSED` que move saldo sem lançamento no ledger. */
    processedWithoutLedger: number;
    /** Lançamento cuja transação não está `PROCESSED`. */
    ledgerWithoutProcessed: number;
    /** Transação fora de `PROCESSED` e `REJECTED` (a carga não manda referência). */
    nonTerminal: number;
    /** Kind fora de OPENING, BET e WIN (a carga não manda outros). */
    unexpectedKinds: number;
    /** `REJECTED` com código diferente de `INSUFFICIENT_FUNDS`. */
    unexpectedRejections: number;
  };
  /** Um por passo HTTP de chaves únicas (aquecimento, A, B). */
  steps: {
    name: string;
    /** Operações enviadas (keys distintas). */
    ops: number;
    /** Operações com resposta final `200` ou `422`. */
    resolved: number;
    /** Operações que esgotaram os reenvios com `503`. */
    gaveUp: number;
    unexpected: number;
    /** Transações do passo no banco. */
    dbTransactions: number;
  }[];
  /** C: duplicatas da mesma key; ausente se o C não rodou (D26.12). */
  duplicates:
    | {
        keys: number;
        dbTransactions: number;
        /** Respostas com `idempotentReplay: false`, na posição da key (0..keys-1). Key sem posição = 0. */
        originalsPerKey: number[];
        unexpected: number;
        /** Aumento de `wagering_duplicates_total` durante o C, por camada (D17.7). */
        caughtAt: { lock: number; uniqueIndex: number };
      }
    | undefined;
  /** D: mensagens pela fila; ausente se o D não rodou (D26.12). */
  queue:
    | {
        messages: number;
        inbox: number;
        transactions: number;
        dlqDelta: number;
        /** Mensagens que o `SendMessageBatch` não aceitou (status ou `Failed`). */
        unexpected: number;
        /** A fila ficou vazia dentro do teto. */
        drained: boolean;
      }
    | undefined;
  /**
   * A outbox esvaziou dentro do teto **no fim da rodada** (D26.6). A espera
   * depois de cada passo é medição: vai para o relatório e não reprova.
   */
  outboxDrained: boolean;
}

export interface Verdict {
  ok: boolean;
  failures: string[];
}

const DB_CHECKS: Record<keyof RoundFacts["db"], string> = {
  negativeWallets: "wallets com saldo negativo",
  balanceMismatches: "wallets com saldo diferente da soma das transações PROCESSED",
  processedWithoutLedger: "transações PROCESSED que movem saldo sem lançamento no ledger",
  ledgerWithoutProcessed: "lançamentos no ledger de transação que não está PROCESSED",
  nonTerminal: "transações fora de PROCESSED/REJECTED",
  unexpectedKinds: "transações de kind que a carga não manda",
  unexpectedRejections: "transações REJECTED com código diferente de INSUFFICIENT_FUNDS",
};

export function evaluateRound(facts: RoundFacts): Verdict {
  const failures: string[] = [];
  const fail = (message: string) => failures.push(message);

  if (facts.wallets.found !== facts.wallets.expected) {
    fail(`wallets da rodada no banco: ${facts.wallets.found} de ${facts.wallets.expected}`);
  }

  const recon = facts.reconciliation;
  if (recon.inconsistent.length > 0) {
    fail(`reconciliação com consistent: false em ${recon.inconsistent.length} wallets: ${recon.inconsistent.join(", ")}`);
  }
  if (recon.failedCalls > 0) fail(`${recon.failedCalls} chamadas de reconciliação falharam`);
  // Sem falha já contada acima, toda wallet da rodada precisa ter sido reconciliada.
  if (recon.consistent !== recon.expected && recon.inconsistent.length === 0 && recon.failedCalls === 0) {
    fail(`reconciliação consistente em ${recon.consistent} de ${recon.expected} wallets`);
  }

  for (const [key, label] of Object.entries(DB_CHECKS) as [keyof RoundFacts["db"], string][]) {
    if (facts.db[key] > 0) fail(`${facts.db[key]} ${label}`);
  }

  for (const step of facts.steps) {
    if (step.unexpected > 0) fail(`${step.name}: ${step.unexpected} respostas com status inesperado`);
    if (step.dbTransactions < step.resolved) {
      fail(`${step.name}: ${step.resolved} operações confirmadas (200/422), mas só ${step.dbTransactions} transações no banco`);
    }
    if (step.dbTransactions > step.ops) {
      fail(`${step.name}: ${step.dbTransactions} transações no banco para ${step.ops} operações enviadas`);
    }
  }

  const dup = facts.duplicates;
  if (dup !== undefined) {
    if (dup.unexpected > 0) fail(`duplicatas: ${dup.unexpected} respostas com status inesperado`);
    if (dup.dbTransactions !== dup.keys) fail(`duplicatas: ${dup.dbTransactions} transações no banco para ${dup.keys} keys`);
    const originals = (key: number) => dup.originalsPerKey[key] ?? 0;
    const keys = Array.from({ length: dup.keys }, (_, key) => key);
    const none = keys.filter((key) => originals(key) === 0);
    const many = keys.filter((key) => originals(key) > 1);
    if (none.length > 0) {
      fail(`duplicatas: ${none.length} keys sem nenhuma resposta original (idempotentReplay: false): ${none.join(", ")}`);
    }
    if (many.length > 0) {
      const detail = many.map((key) => `${key} (${originals(key)})`).join(", ");
      fail(`duplicatas: ${many.length} keys com mais de uma resposta original (idempotentReplay: false): ${detail}`);
    }
    if (dup.caughtAt.lock === 0) {
      fail("duplicatas: nenhuma pega no lock (wagering_duplicates_total{layer=\"lock\"}): as cópias não disputaram de verdade");
    }
  }

  const queue = facts.queue;
  if (queue !== undefined) {
    if (queue.unexpected > 0) fail(`fila: ${queue.unexpected} mensagens com status inesperado no envio`);
    if (queue.inbox !== queue.messages) fail(`fila: ${queue.inbox} linhas na inbox para ${queue.messages} mensagens`);
    if (queue.transactions !== queue.messages) {
      fail(`fila: ${queue.transactions} transações no banco para ${queue.messages} mensagens`);
    }
    if (queue.dlqDelta !== 0) fail(`fila: ${queue.dlqDelta} mensagens novas na DLQ`);
    if (!queue.drained) fail("fila: não esvaziou dentro do teto");
  }

  if (!facts.outboxDrained) fail("outbox: não esvaziou dentro do teto");

  return { ok: failures.length === 0, failures };
}
