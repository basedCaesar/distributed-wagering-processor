import type { Verdict } from "./evaluate";
import { LOAD_PLAN } from "./plan";
import type { Quantile } from "./prometheus";

/**
 * Relatório gerado de cada execução do `test:load` (D26.7, R-14-O1):
 * ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de
 * concorrência e outbox lag, por passo e por rodada, e o veredito da
 * correção. O `docs/load-test.md` versionado copia os números daqui e
 * acrescenta a análise.
 */

export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface StepResult {
  scenario: "A" | "B" | "C" | "D";
  label: string;
  /** Chegadas por segundo pedidas ao k6; ausente nos cenários sem taxa (C, D). */
  targetRate: number | undefined;
  durationS: number;
  /** Operações (keys ou mensagens) enviadas. */
  ops: number;
  processed: number;
  rejected: number;
  replays: number;
  /** Tentativas que voltaram `503`. */
  transientAttempts: number;
  /** Operações que esgotaram os reenvios com `503`. */
  gaveUp: number;
  unexpected: number;
  /** Iterações que o k6 não conseguiu iniciar (faltou VU): o cliente virou gargalo. */
  droppedIterations: number;
  /** Operações resolvidas (200/422) por segundo de passo. */
  throughput: number;
  /** Por tentativa HTTP, em ms (todas as amostras, k6). */
  latencyMs: Percentiles | undefined;
  /** Por operação, do 1º envio à resposta final, com as esperas dos reenvios. */
  opLatencyMs: Percentiles | undefined;
  lockConflicts: Record<string, number>;
  /** Espera do lock da wallet, em s, estimada pelos buckets (D22.5). */
  lockWait: { p50: Quantile; p95: Quantile; p99: Quantile };
  retries: Record<string, number>;
  /** Amostrado a cada 1 s nos publishers durante o passo (D22.6). */
  outboxLag: { max: number | undefined; p95: number | undefined; pendingMax: number | undefined; drainS: number | undefined };
  /** Só D: do 1º envio até a fila vazia. */
  queueDrainS?: number;
  /** Latência de processamento em volta do use case (D22.7), estimada pelos buckets, em s. */
  processing?: { channel: "http" | "sqs"; p50: Quantile; p95: Quantile; p99: Quantile };
  /** Quanto o orquestrador esperou o repouso antes do passo (D26.11). */
  quiesceS?: number;
  /** Em quantas leituras cada motivo segurou o repouso (D26.11). */
  quiesceHolds?: Record<string, number>;
  /** D26.13: fila do auditor no início do passo e a vazão medida durante o repouso. */
  auditorBacklog?: { depth: number; ratePerS: number | undefined };
}

export interface RoundResult {
  round: number;
  steps: StepResult[];
  verdict: Verdict;
}

export interface LoadResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  environment: Record<string, string>;
  /** Pedidos de token ao Keycloak na execução inteira (fora da medição, D26.3). */
  tokenRequests: number;
  /** Cenários que rodaram (D26.12); ausente = todos. */
  scenarios?: string[];
  rounds: RoundResult[];
}

function trimNumber(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

/** ms com 1 casa abaixo de 100 ms, inteiro acima. */
export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return ms < 100 ? `${trimNumber(ms, 1)} ms` : `${trimNumber(ms, 0)} ms`;
}

/** Percentil em segundos (buckets) mostrado em ms; acima do maior bucket vira `> N`. */
export function formatSeconds(value: Quantile): string {
  if (value === undefined) return "—";
  if (typeof value === "object") return `> ${formatMs(value.above * 1000)}`;
  return formatMs(value * 1000);
}

function percent(part: number, total: number): string {
  if (total === 0) return "—";
  return `${trimNumber((part / total) * 100, 2)}%`;
}

function counts(record: Record<string, number>): string {
  const entries = Object.entries(record).filter(([, n]) => n > 0);
  return entries.length === 0 ? "0" : entries.map(([k, n]) => `${k}: ${n}`).join(", ");
}

function optional(value: number | undefined, unit: string, decimals = 1): string {
  return value === undefined ? "—" : `${trimNumber(value, decimals)}${unit}`;
}

function methodology(): string {
  const p = LOAD_PLAN;
  return [
    "## Metodologia",
    "",
    "- Cliente: k6 num container na rede do Compose de dev, chamando o `nginx:80` (3 `api`); o `/metrics` de cada processo é lido pela porta interna (D22.1), sem porta exposta.",
    "- Modelo aberto (`constant-arrival-rate`): o k6 inicia as chegadas na taxa pedida sem esperar a resposta anterior, então a latência não é escondida pela própria lentidão (coordinated omission). Iterações que o k6 não consegue iniciar por falta de VU aparecem como descartadas.",
    `- Aquecimento descartado: ${p.warmup.rate} req/s por ${p.warmup.durationS} s antes do cenário A.`,
    `- A (throughput): ${p.throughput.wallets} wallets, 70% BET e 30% WIN sem referência, chaves únicas, degraus de ${p.throughput.steps.map((s) => s.rate).join(" → ")} req/s, ${p.throughput.steps[0]?.durationS} s cada.`,
    `- B (hot wallet): uma wallet nova por degrau, BETs de chaves únicas, saldo para 70% delas; degraus de ${p.hotWallet.steps.map((s) => s.rate).join(" → ")} req/s.`,
    `- C (duplicatas): ${p.duplicates.keys} keys, cada uma enviada ${p.duplicates.copies} vezes quase ao mesmo tempo (um VU por cópia), em ${p.duplicates.wallets} wallets.`,
    `- D (fila): ${p.queue.messages} mensagens do §10 em ${p.queue.wallets} wallets (\`MessageGroupId\` = walletId), por \`SendMessageBatch\` direto na API HTTP do SQS do LocalStack (atalho só do LocalStack, D26.9).`,
    `- \`503\` é transitório (D5): o cliente reenvia com a mesma key, respeitando o \`Retry-After\`, até ${p.maxAttempts} tentativas. Latência "por tentativa" é cada requisição; "por operação" inclui as esperas dos reenvios.`,
    "- Taxa de erro = (desistências depois dos reenvios + status inesperados) / operações. `503` na tentativa aparece à parte.",
    "- Conflitos de lock, espera do lock, retries e latência do consumidor: diferença do `/metrics` antes e depois do passo, somada entre as instâncias. Percentis dessas métricas são **estimados pelos buckets** do histograma (erro do tamanho do bucket); os do k6 usam todas as amostras.",
    `- Outbox lag: o \`outbox_lag_seconds\` dos 2 publishers, lido a cada 1 s durante o passo; depois do passo, o tempo até a outbox esvaziar (teto de ${p.drainTimeoutS} s).`,
    "- Tokens: um por passo, pedido antes do passo e fora da medição (D26.3).",
    `- Repouso antes de cada passo (D26.11): outbox vazia, nenhuma sessão da app ativa no banco e nenhuma operação concluída entre duas leituras do \`/metrics\` seguidas, com teto de ${p.quiesceTimeoutS} s; o tempo esperado e o motivo (em quantas leituras cada condição segurou) aparecem por passo. O \`event-auditor\` fica fora da condição (D26.13); a fila dele e a vazão são registradas antes de cada passo como contaminação conhecida.`,
    "- Latência de processamento (D22.7): em volta do use case, por canal, estimada pelos buckets; separa o tempo dentro da api do tempo de fila no nginx e no pool de conexões.",
    "- Correção (D26.6): reconciliação de todas as wallets da rodada e consultas no banco. Latência nunca reprova.",
    "- Postgres com a configuração padrão de durabilidade (`synchronous_commit = on`, `fsync = on`): o commit espera o flush do WAL. Ele não foi mexido de propósito: não trocamos durabilidade de dinheiro por vazão.",
  ].join("\n");
}

function stepRows(steps: StepResult[]): string {
  const header = [
    "| Passo | Alvo | Operações | Throughput (op/s) | p50 | p95 | p99 | máx | p99 por operação | `503` (tentativas) | Desistências | Inesperados | Descartadas (k6) | Taxa de erro |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const rows = steps.map((s) =>
    [
      s.label,
      s.targetRate === undefined ? "—" : `${s.targetRate}/s`,
      s.ops,
      trimNumber(s.throughput, 1),
      formatMs(s.latencyMs?.p50),
      formatMs(s.latencyMs?.p95),
      formatMs(s.latencyMs?.p99),
      formatMs(s.latencyMs?.max),
      formatMs(s.opLatencyMs?.p99),
      s.transientAttempts,
      s.gaveUp,
      s.unexpected,
      s.droppedIterations,
      percent(s.gaveUp + s.unexpected, s.ops),
    ].join(" | "),
  );
  return [...header, ...rows.map((r) => `| ${r} |`)].join("\n");
}

function outcomeRows(steps: StepResult[]): string {
  const header = ["| Passo | PROCESSED | REJECTED | Replays |", "|---|---|---|---|"];
  const rows = steps.map((s) => `| ${s.label} | ${s.processed} | ${s.rejected} | ${s.replays} |`);
  return [...header, ...rows].join("\n");
}

function concurrencyRows(steps: StepResult[]): string {
  const header = [
    "| Passo | Repouso antes | Conflitos de lock | Espera do lock p50 | p95 | p99 | Processamento (canal) p50 | p95 | p99 | Retries | Outbox lag máx | Outbox lag p95 | Pendentes máx | Outbox esvaziou em |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const rows = steps.map((s) =>
    [
      s.label,
      optional(s.quiesceS, " s"),
      counts(s.lockConflicts),
      formatSeconds(s.lockWait.p50),
      formatSeconds(s.lockWait.p95),
      formatSeconds(s.lockWait.p99),
      s.processing === undefined ? "—" : `${formatSeconds(s.processing.p50)} (${s.processing.channel})`,
      formatSeconds(s.processing?.p95),
      formatSeconds(s.processing?.p99),
      counts(s.retries),
      optional(s.outboxLag.max, " s"),
      optional(s.outboxLag.p95, " s"),
      optional(s.outboxLag.pendingMax, "", 0),
      optional(s.outboxLag.drainS, " s"),
    ].join(" | "),
  );
  return [...header, ...rows.map((r) => `| ${r} |`)].join("\n");
}

function queueRows(steps: StepResult[]): string {
  const queue = steps.filter((s) => s.queueDrainS !== undefined);
  if (queue.length === 0) return "";
  const header = [
    "| Passo | Mensagens | Fila vazia em | Throughput (msg/s) | Consumidor p50 | p95 | p99 |",
    "|---|---|---|---|---|---|---|",
  ];
  const rows = queue.map((s) =>
    [
      s.label,
      s.ops,
      optional(s.queueDrainS, " s"),
      trimNumber(s.throughput, 1),
      formatSeconds(s.processing?.p50),
      formatSeconds(s.processing?.p95),
      formatSeconds(s.processing?.p99),
    ].join(" | "),
  );
  return ["", "**Fila (D)**", "", ...header, ...rows.map((r) => `| ${r} |`)].join("\n");
}

function quiesceRows(steps: StepResult[]): string {
  const header = [
    "| Passo | Repouso antes | Motivo da espera (leituras que cada motivo segurou) | Fila do auditor antes | Vazão do auditor |",
    "|---|---|---|---|---|",
  ];
  const rows = steps.map((s) => {
    const holds = Object.entries(s.quiesceHolds ?? {})
      .sort(([, a], [, b]) => b - a)
      .map(([reason, n]) => `${reason} ×${n}`)
      .join(", ");
    const depth = s.auditorBacklog === undefined ? "—" : String(s.auditorBacklog.depth);
    // Negativa: entrou mais na fila do que o auditor consumiu (ainda chegavam eventos).
    const rate = s.auditorBacklog?.ratePerS === undefined ? "—" : `${trimNumber(s.auditorBacklog.ratePerS, 1)}/s`;
    return `| ${s.label} | ${optional(s.quiesceS, " s")} | ${holds === "" ? "—" : holds} | ${depth} | ${rate} |`;
  });
  return [...header, ...rows].join("\n");
}

function verdictText(verdict: Verdict): string {
  if (verdict.ok) return "**Correção: PASSOU.**";
  return ["**Correção: FALHOU.**", "", ...verdict.failures.map((f) => `- ${f}`)].join("\n");
}

export function renderReport(result: LoadResult): string {
  const env = Object.entries(result.environment).map(([k, v]) => `| ${k} | ${v} |`);
  const allOk = result.rounds.every((r) => r.verdict.ok);
  const rounds = result.rounds.map((round) =>
    [
      `## Rodada ${round.round}`,
      "",
      verdictText(round.verdict),
      "",
      "### Throughput, latência (p50, p95, p99) e taxa de erro",
      "",
      "Latência por tentativa HTTP (k6, todas as amostras).",
      "",
      stepRows(round.steps),
      queueRows(round.steps),
      "",
      "### Desfechos",
      "",
      outcomeRows(round.steps),
      "",
      "### Conflitos de lock e outbox lag",
      "",
      "Espera do lock estimada pelos buckets do `wallet_lock_wait_seconds` (D22.5).",
      "",
      concurrencyRows(round.steps),
      "",
      "### Repouso antes de cada passo",
      "",
      "Leituras a cada ~3 s (mais ~10 s do container do k6 por leitura); a 1ª nunca basta (D26.11). O `event-auditor` fica fora do repouso (D26.13): a fila dele no início do passo é **contaminação conhecida**, porque ele ainda trabalha e disputa o WAL do Postgres com o passo medido. O atraso dele não afeta a correção (ele só confere e registra). A vazão é a queda da fila por segundo durante o repouso; negativa quando ainda entravam eventos.",
      "",
      quiesceRows(round.steps),
    ].join("\n"),
  );
  return [
    `# Teste de carga: execução ${result.runId}`,
    "",
    `${result.startedAt} → ${result.finishedAt} · ${result.rounds.length} rodada(s) · Cenários: ${(result.scenarios ?? ["A", "B", "C", "D"]).join(", ")} · ${allOk ? "todas PASSARAM na correção" : "alguma FALHOU na correção"}`,
    "",
    "## Ambiente",
    "",
    "| Item | Valor |",
    "|---|---|",
    ...env,
    `| Pedidos de token ao Keycloak (fora da medição) | ${result.tokenRequests} |`,
    "",
    methodology(),
    "",
    ...rounds,
    "",
  ].join("\n");
}
