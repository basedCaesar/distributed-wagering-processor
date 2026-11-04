import { InvalidOutboxTransitionError } from "./domain-error";
import type { IntegrationEvent } from "./events/integration-event";

/** Teto do backoff de 2ⁿ s (D9.6, D20.4). */
export const OUTBOX_BACKOFF_MAX_SECONDS = 300;

/** A partir desta tentativa, cada falha é um alerta; o evento nunca é descartado (D9.6, D20.4). */
export const OUTBOX_ALERT_AFTER_ATTEMPTS = 20;

/** 2⁸ = 256 s é a última potência abaixo do teto de 300 s; 2⁹ = 512 s já passa dele. */
const BACKOFF_EXPONENT_CAP = 9;

/** 2ⁿ s, n = a tentativa que acabou de falhar (começa em 1), até o teto (D20.4). */
export function outboxBackoffSeconds(attempt: number): number {
  // Teto pelo expoente: o domínio não usa as funções numéricas globais (CLAUDE.md, lint).
  if (attempt >= BACKOFF_EXPONENT_CAP) return OUTBOX_BACKOFF_MAX_SECONDS;
  return 2 ** attempt;
}

/** O evento já falhou `attempts` vezes: alerta, sem nunca descartar (D9.6, D20.4). */
export function isOutboxStalled(attempts: number): boolean {
  return attempts >= OUTBOX_ALERT_AFTER_ATTEMPTS;
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  /** `walletId` (D9.3): a ordem e o `MessageGroupId` (D9.1, D9.2). */
  orderingKey: string;
  eventType: string;
  /** O envelope do §11. */
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
}

/**
 * Evento na outbox (§6.5, D9, D20, D24). Estado e transições: pendente →
 * publicado, com retry e backoff no meio; nunca descartado (D9.6).
 *
 * O que fica no SQL, e não aqui: o claim por cabeça de wallet com `SKIP
 * LOCKED`, o lease e o dono (`locked_by`), o filtro de vencidos entre
 * instâncias e o relógio (`now()` do banco, D18.12). `isDue` é a mesma
 * regra do filtro, mas a infra não o chama: a garantia entre instâncias
 * precisa do banco (D24).
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly orderingKey: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** Nasce pendente e vencida: o publisher a pega no próximo claim. */
  static enqueue(event: IntegrationEvent<unknown>, orderingKey: string): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      orderingKey,
      event.eventType,
      event.toJSON() as unknown as Readonly<Record<string, unknown>>,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  /** Reconstrói o estado persistido, sem revalidar (§6.0). */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.orderingKey,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  toState(): OutboxMessageState {
    return {
      id: this.id,
      aggregateId: this.aggregateId,
      orderingKey: this.orderingKey,
      eventType: this.eventType,
      payload: this.payload,
      occurredAt: this.occurredAt,
      attempts: this._attempts,
      nextAttemptAt: this._nextAttemptAt,
      publishedAt: this._publishedAt,
    };
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    return this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime();
  }

  /** Passou do limite de tentativas: alerta, sem descartar (D9.6, D20.4). */
  isStalled(): boolean {
    return isOutboxStalled(this._attempts);
  }

  markPublished(at: Date): void {
    this.assertPending("publicar");
    this._publishedAt = at;
  }

  /** Tentativa + 1 e próxima tentativa em `now` + 2ⁿ s, até 300 s (D20.4). */
  scheduleRetry(now: Date): void {
    this.assertPending("agendar retry de");
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + outboxBackoffSeconds(this._attempts) * 1000);
  }

  private assertPending(action: string): void {
    if (!this.isPending()) {
      throw new InvalidOutboxTransitionError(`não dá para ${action} evento ${this.id} já publicado`);
    }
  }
}
