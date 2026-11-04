import { describe, expect, it } from "bun:test";
import { InvalidOutboxTransitionError } from "../../../src/modules/wagering/domain/domain-error";
import {
  IntegrationEvent,
  type IntegrationEventProps,
} from "../../../src/modules/wagering/domain/events/integration-event";
import {
  OUTBOX_ALERT_AFTER_ATTEMPTS,
  OUTBOX_BACKOFF_MAX_SECONDS,
  OutboxMessage,
  outboxBackoffSeconds,
} from "../../../src/modules/wagering/domain/outbox-message";

class SampleEvent extends IntegrationEvent<{ walletId: string }> {
  readonly eventType = "SampleEvent";
  readonly version = 1;
  constructor(props: IntegrationEventProps<{ walletId: string }>) {
    super(props);
  }
}

const T0 = new Date("2026-11-03T12:00:00.000Z");
const WALLET = "0192f291-27dd-7d3f-8071-5f8685deef37";
const TX = "0192f291-27dd-7d3f-8071-5f8685deef99";

function event(): SampleEvent {
  return new SampleEvent({
    eventId: "0193f1c2-0000-7000-8000-000000000001",
    aggregateId: TX,
    correlationId: "corr-1",
    causationId: "msg-1",
    occurredAt: T0,
    data: { walletId: WALLET },
  });
}

const seconds = (from: Date, to: Date | undefined) => ((to?.getTime() ?? 0) - from.getTime()) / 1000;

describe("§6.5 D24: OutboxMessage", () => {
  it("D24 D9.3: enqueue copia o envelope, com aggregateId e orderingKey separados; nasce pendente e vencida", () => {
    const message = OutboxMessage.enqueue(event(), WALLET);
    expect(message.id).toBe(event().eventId);
    expect(message.aggregateId).toBe(TX);
    expect(message.orderingKey).toBe(WALLET);
    expect(message.eventType).toBe("SampleEvent");
    expect(message.payload).toEqual(event().toJSON() as unknown as Record<string, unknown>);
    expect(message.occurredAt).toEqual(T0);
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toEqual(T0);
    expect(message.publishedAt).toBeUndefined();
    expect(message.isPending()).toBe(true);
    expect(message.isDue(T0)).toBe(true);
  });

  it("D24: isDue só a partir do nextAttemptAt, e nunca depois de publicado", () => {
    const message = OutboxMessage.enqueue(event(), WALLET);
    message.scheduleRetry(T0);
    expect(message.isDue(new Date(T0.getTime() + 1_999))).toBe(false);
    expect(message.isDue(new Date(T0.getTime() + 2_000))).toBe(true);
    message.markPublished(new Date(T0.getTime() + 3_000));
    expect(message.isDue(new Date(T0.getTime() + 60_000))).toBe(false);
  });

  it("D24 D20.4: scheduleRetry soma uma tentativa e agenda 2ⁿ s depois de now", () => {
    const message = OutboxMessage.enqueue(event(), WALLET);
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      message.scheduleRetry(T0);
      delays.push(seconds(T0, message.nextAttemptAt));
    }
    expect(message.attempts).toBe(5);
    expect(delays).toEqual([2, 4, 8, 16, 32]);
    expect(message.isPending()).toBe(true);
  });

  it("D20.4: backoff de 2ⁿ s pela tentativa que falhou, até 300 s", () => {
    expect(OUTBOX_BACKOFF_MAX_SECONDS).toBe(300);
    expect([1, 2, 3, 4, 5, 8].map((n) => outboxBackoffSeconds(n))).toEqual([2, 4, 8, 16, 32, 256]);
    expect(outboxBackoffSeconds(9)).toBe(300);
    expect(outboxBackoffSeconds(40)).toBe(300);
  });

  it("D24 D20.4: no scheduleRetry, o teto de 300 s vale a partir da 9ª tentativa", () => {
    const message = OutboxMessage.rehydrate({ ...OutboxMessage.enqueue(event(), WALLET).toState(), attempts: 8 });
    message.scheduleRetry(T0);
    expect(message.attempts).toBe(9);
    expect(seconds(T0, message.nextAttemptAt)).toBe(300);
  });

  it("D9.6 D20.4: alerta a partir da 20ª tentativa, sem nunca descartar", () => {
    expect(OUTBOX_ALERT_AFTER_ATTEMPTS).toBe(20);
    const at = (attempts: number) =>
      OutboxMessage.rehydrate({ ...OutboxMessage.enqueue(event(), WALLET).toState(), attempts });
    expect(at(19).isStalled()).toBe(false);
    expect(at(20).isStalled()).toBe(true);
    expect(at(57).isStalled()).toBe(true);
    const stalled = at(57);
    stalled.scheduleRetry(T0);
    expect(stalled.isPending()).toBe(true);
    expect(seconds(T0, stalled.nextAttemptAt)).toBe(300);
  });

  it("D24: markPublished grava o horário e encerra a pendência", () => {
    const message = OutboxMessage.enqueue(event(), WALLET);
    const at = new Date(T0.getTime() + 500);
    message.markPublished(at);
    expect(message.publishedAt).toEqual(at);
    expect(message.isPending()).toBe(false);
  });

  it("D24: publicar duas vezes → InvalidOutboxTransitionError", () => {
    const message = OutboxMessage.enqueue(event(), WALLET);
    message.markPublished(T0);
    expect(() => message.markPublished(T0)).toThrow(InvalidOutboxTransitionError);
  });

  it("D24: retry depois de publicado → InvalidOutboxTransitionError, sem mudar o estado", () => {
    const message = OutboxMessage.enqueue(event(), WALLET);
    message.markPublished(T0);
    expect(() => message.scheduleRetry(T0)).toThrow(InvalidOutboxTransitionError);
    expect(message.attempts).toBe(0);
  });

  it("§6.0 D24: rehydrate reconstrói o estado sem revalidar (inclusive um que enqueue não produziria)", () => {
    const published = new Date(T0.getTime() + 1_000);
    const message = OutboxMessage.rehydrate({
      id: "x",
      aggregateId: "y",
      orderingKey: "z",
      eventType: "Whatever",
      payload: {},
      occurredAt: T0,
      attempts: -3,
      nextAttemptAt: undefined,
      publishedAt: published,
    });
    expect(message.attempts).toBe(-3);
    expect(message.nextAttemptAt).toBeUndefined();
    expect(message.publishedAt).toEqual(published);
    expect(message.isPending()).toBe(false);
  });
});
