import type { Logger } from "pino";
import { classifyError } from "../../../../shared/errors/classify-error";
import { runWithContext } from "../../../../shared/logger/request-context";
import { OUTBOX_POLICY, type OutboxPolicy, outboxBackoffSeconds, stalled } from "./outbox-policy";

/** Evento pego pelo claim: a cabeça não publicada de uma wallet (D20.3). */
export interface ClaimedEvent {
  id: string;
  /** `walletId` (D9.3): o `MessageGroupId` no SNS (D9.1). */
  orderingKey: string;
  eventType: string;
  /** O envelope do §11, como está no `jsonb` (D20.9). */
  payload: Record<string, unknown>;
  /** Falhas anteriores (D9.6). */
  attempts: number;
}

/**
 * A outbox vista pelo publisher (D9.6, D20.3, D20.5). Cada operação é um
 * comando só, numa transação curta e commitada; nenhuma segura lock.
 */
export interface OutboxStore {
  /**
   * Até `limit` cabeças de wallet, com lease e dono (`leaseToken`). Pula a
   * wallet cuja cabeça está com lease, em backoff ou travada.
   */
  claimHeads(limit: number, leaseMs: number, leaseToken: string): Promise<ClaimedEvent[]>;
  /** `published_at = now()` e lease solto, só onde o dono ainda é `leaseToken`. Devolve os marcados. */
  markPublished(ids: readonly string[], leaseToken: string): Promise<string[]>;
  /**
   * Tentativa + 1, código, próxima tentativa em `backoffSeconds` e lease
   * solto, só se o dono ainda é `leaseToken`. Devolve as tentativas, ou
   * `undefined` se o lease já era de outro.
   */
  recordFailure(
    id: string,
    leaseToken: string,
    failure: { errorCode: string; backoffSeconds: number },
  ): Promise<number | undefined>;
}

/** Publica um evento no tópico (D9.1). Erro → o evento continua na outbox. */
export interface EventPublisher {
  publish(event: ClaimedEvent): Promise<void>;
}

/** Alerta da D9.6/D20.4: o evento passou do limite de tentativas. */
export interface OutboxAlerts {
  countStalled(): void;
}

export interface PublishRound {
  claimed: number;
  published: string[];
  failed: string[];
}

/**
 * Publisher da outbox (R-11-02, R-11-03, D9.6, D20). A cada rodada: claim
 * curto das cabeças de wallet (`SKIP LOCKED`, lease e dono), publicação do
 * lote em paralelo (uma wallet por evento, então a ordem por wallet se
 * mantém) e, só depois do SNS confirmar, a marcação. Falha → tentativa + 1
 * e backoff; **nunca descarta** (D9.6). Com algo pego, a próxima rodada
 * sai na hora; claim vazio → espera `idleMs` (D20.3).
 *
 * Todo erro passa por `classifyError()`. Logs sem payload nem valores (D11.1).
 */
export class OutboxPublisher {
  /** Dono dos leases deste publisher (D20.5). */
  readonly leaseToken = Bun.randomUUIDv7();
  private readonly policy: OutboxPolicy;
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly logger: Logger,
    private readonly alerts: OutboxAlerts,
    policy: Partial<OutboxPolicy> = {},
  ) {
    this.policy = { ...OUTBOX_POLICY, ...policy };
  }

  /** Um claim, a publicação do lote e as marcações. */
  async runOnce(): Promise<PublishRound> {
    const claimed = await this.store.claimHeads(this.policy.batchSize, this.policy.leaseMs, this.leaseToken);
    const outcomes = await Promise.all(claimed.map((event) => this.publishOne(event)));
    const published = claimed.filter((_, index) => outcomes[index]).map((event) => event.id);
    const failed = claimed.filter((_, index) => !outcomes[index]).map((event) => event.id);
    if (published.length > 0) {
      const marked = await this.store.markPublished(published, this.leaseToken);
      if (marked.length < published.length) {
        // O lease venceu e outro publisher pegou: ele publica de novo (seguro, D20.5).
        this.logger.warn({ lost: published.length - marked.length }, "evento publicado com lease vencido");
      }
    }
    return { claimed: claimed.length, published, failed };
  }

  start(): void {
    if (this.loop) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Para de buscar, termina a rodada atual; os leases dos outros vencem sozinhos (D8.6). */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      try {
        claimed = (await this.runOnce()).claimed;
      } catch (error) {
        const { category, code } = classifyError(error);
        this.logger.warn({ category, code }, "rodada do publisher falhou");
      }
      if (this.running && claimed === 0) await this.pause();
    }
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(resolve, this.policy.idleMs);
    });
  }

  /** `true` se o SNS confirmou. A falha é gravada aqui mesmo. */
  private publishOne(event: ClaimedEvent): Promise<boolean> {
    const correlationId = typeof event.payload.correlationId === "string" ? event.payload.correlationId : undefined;
    const context = { walletId: event.orderingKey, ...(correlationId !== undefined && { correlationId }) };
    return runWithContext(context, async () => {
      try {
        await this.publisher.publish(event);
        return true;
      } catch (error) {
        const { category, code } = classifyError(error);
        await this.recordFailure(event, code, category);
        return false;
      }
    });
  }

  private async recordFailure(event: ClaimedEvent, errorCode: string, category: string): Promise<void> {
    const attempt = event.attempts + 1;
    const backoffSeconds = outboxBackoffSeconds(attempt, this.policy.backoffMaxSeconds);
    const fields = { eventId: event.id, eventType: event.eventType, category, code: errorCode, attempt, backoffSeconds };
    let attempts: number | undefined;
    try {
      attempts = await this.store.recordFailure(event.id, this.leaseToken, { errorCode, backoffSeconds });
    } catch (recordError) {
      // O lease vence sozinho e outra rodada tenta de novo.
      const { category: recordCategory, code: recordCode } = classifyError(recordError);
      this.logger.error({ ...fields, recordCategory, recordCode }, "falha de publicação não registrada; o lease vence");
      return;
    }
    if (attempts === undefined) {
      this.logger.warn(fields, "falha de publicação com lease de outro publisher; nada registrado");
      return;
    }
    if (stalled(attempts, this.policy.alertAfterAttempts)) {
      this.alerts.countStalled();
      this.logger.error(
        { ...fields, attempts },
        `evento da outbox sem publicar depois de ${this.policy.alertAfterAttempts} tentativas; continua tentando`,
      );
      return;
    }
    this.logger.warn({ ...fields, attempts }, "publicação falhou; nova tentativa com backoff");
  }
}
