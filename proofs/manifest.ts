/**
 * As provas da S8 (D11.4, D21.8): cada patch remove uma proteção, e o
 * teste nomeado precisa **falhar** com ela removida (e passar sem o patch).
 * Mesma ordem da lista do plano e da tabela do `AI_WORKFLOW.md`.
 */
export interface Proof {
  id: number;
  /** A proteção que o patch remove. */
  protection: string;
  patch: string;
  /** O arquivo e o título exato (`it`) do teste que precisa falhar. */
  file: string;
  test: string;
}

export const PROOFS: Proof[] = [
  {
    id: 1,
    protection: "`FOR UPDATE` da wallet (D7.2)",
    patch: "01-for-update.patch",
    file: "test/concurrency/submit-transaction.spec.ts",
    test: "R-13-C2 R-08-03 R-08-09: saldo 100.00, duas BETs de 80.00 esperando o mesmo lock → 1 PROCESSED, 1 REJECTED INSUFFICIENT_FUNDS, saldo 20.00, 1 DEBIT",
  },
  {
    id: 2,
    protection: "índice de uma reversão `PROCESSED` por referência (D1.1)",
    patch: "02-reversal-index.patch",
    file: "test/integration/schema/wager-transactions.spec.ts",
    test: "R-07-09 D1.1: duas reversões PROCESSED da mesma referência (REFUND + ROLLBACK) → UNIQUE",
  },
  {
    id: 3,
    protection: "`CHECK` de saldo ≥ 0 (D7.3)",
    patch: "03-balance-check.patch",
    file: "test/integration/schema/wallets.spec.ts",
    test: "R-05-09 R-06-25 D7.3: saldo negativo → CHECK",
  },
  {
    id: 4,
    protection: "trigger append-only do ledger (D7.3)",
    patch: "04-ledger-append-only.patch",
    file: "test/integration/schema/ledger.spec.ts",
    test: "R-05-05 D7.3 (P2, papel dono): UPDATE no ledger → trigger append-only",
  },
  {
    id: 5,
    protection: "`SKIP LOCKED` no claim do worker de pendentes (D4.3)",
    patch: "05-pending-skip-locked.patch",
    file: "test/concurrency/pending-worker.spec.ts",
    test: "D4.3 D18.2: com um claim em andamento segurando as linhas (FOR UPDATE numa transação aberta), o segundo claim pula essas linhas sem esperar; depois o lease as protege",
  },
  {
    id: 6,
    protection: "`SKIP LOCKED` no claim da outbox (D20.3)",
    patch: "06-outbox-skip-locked.patch",
    file: "test/concurrency/outbox-publisher.spec.ts",
    test: "R-13-C6 D20.3: claim de A em andamento (cabeça travada) → B pula essa wallet sem esperar e não pega o 2º evento dela",
  },
  {
    id: 7,
    protection: "cutucada das pendentes (D4.4)",
    patch: "07-nudge.patch",
    file: "test/integration/wagering/pending-worker.spec.ts",
    test: "D4.4: BET submetida → as pendentes da mesma wallet que a referenciam vencem agora; as de outra referência e de outra wallet, não",
  },
  {
    id: 8,
    protection: "desempate da D18.9 (invertido)",
    patch: "08-tiebreak-inverted.patch",
    file: "test/concurrency/pending-worker.spec.ts",
    test: "D1.1 D1.3 D18.9: REFUND e ROLLBACK pendentes da mesma BET → a criada primeiro é PROCESSED, a outra REFERENCE_ALREADY_REVERSED, um crédito só",
  },
  {
    id: 9,
    protection: "checagem do dono do lease do worker (D18.10)",
    patch: "09-lease-owner.patch",
    file: "test/concurrency/pending-worker.spec.ts",
    test: "D18.10 D4.3: o lease vence com o item em processamento (worker A esperando a wallet), o worker B reclama; A pula sem contar tentativa nem erro, B tenta uma vez",
  },
  {
    id: 10,
    protection: "ack só depois do commit (R-10-05)",
    patch: "10-ack-before-commit.patch",
    file: "test/integration/outbox/atomicity.spec.ts",
    test: "R-13-I2 R-11-01 D20.7: falha no COMMIT depois de gravar transação, ledger, saldo, outbox e inbox → nada fica e não há ack; sem a falha, tudo fica",
  },
  {
    id: 11,
    protection: "inbox (D3.7)",
    patch: "11-inbox.patch",
    file: "test/integration/messaging/consumer.spec.ts",
    test: "R-10-04 R-13-I3 D3.7: a mesma mensagem duas vezes → um efeito; a segunda é duplicata da inbox",
  },
  {
    id: 12,
    protection: "trigger de cauda: saldo = último lançamento (D7.3)",
    patch: "12-ledger-tail.patch",
    file: "test/integration/schema/ledger.spec.ts",
    test: "R-06-21 D7.3: saldo alterado sem lançamento → erro no COMMIT",
  },
  {
    id: 13,
    protection: "papel restrito do banco (D7.3)",
    patch: "13-restricted-role.patch",
    file: "test/integration/schema/privileges.spec.ts",
    test: "D7.3: a app conecta com um papel que não é superusuário nem dono das tabelas",
  },
  {
    id: 14,
    protection: "`AND locked_by = ?` no `markPublished` da outbox (D20.5)",
    patch: "14-mark-published-owner.patch",
    file: "test/integration/outbox/outbox-publisher.spec.ts",
    test: "D20.5: o lease de A vence, B pega o mesmo evento e só então o Publish de A tem sucesso → o mark de A não marca nada (o dono é B) e A loga o lease vencido",
  },
];
