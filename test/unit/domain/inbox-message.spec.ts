import { describe, expect, it } from "bun:test";
import { InvalidInboxTransitionError } from "../../../src/modules/wagering/domain/domain-error";
import { InboxMessage } from "../../../src/modules/wagering/domain/inbox-message";

const T0 = new Date("2026-11-03T12:00:00.000Z");
const T1 = new Date("2026-11-03T12:00:01.000Z");

const received = (payloadHash = "a".repeat(64)) =>
  InboxMessage.receive({
    consumerName: "wager-transactions-consumer",
    messageId: "msg-123",
    payloadHash,
    receivedAt: T0,
  });

describe("§6.5 D24: InboxMessage", () => {
  it("D3.7 D24: receive guarda a chave (consumerName, messageId), o hash e o horário; nasce não processada", () => {
    const message = received();
    expect(message.consumerName).toBe("wager-transactions-consumer");
    expect(message.messageId).toBe("msg-123");
    expect(message.payloadHash).toBe("a".repeat(64));
    expect(message.receivedAt).toEqual(T0);
    expect(message.processedAt).toBeUndefined();
    expect(message.isProcessed()).toBe(false);
  });

  it("D24 D19.4: markProcessed grava o horário", () => {
    const message = received();
    message.markProcessed(T1);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(T1);
  });

  it("D24: processar duas vezes → InvalidInboxTransitionError, sem mudar o horário", () => {
    const message = received();
    message.markProcessed(T0);
    expect(() => message.markProcessed(T1)).toThrow(InvalidInboxTransitionError);
    expect(message.processedAt).toEqual(T0);
  });

  it("D3.8 D24: mesmo conteúdo = mesmo hash", () => {
    expect(received().hasSameContentAs(received())).toBe(true);
    expect(received().hasSameContentAs(received("b".repeat(64)))).toBe(false);
  });

  it("§6.0 D24: rehydrate reconstrói o estado sem revalidar (processada antes de recebida)", () => {
    const message = InboxMessage.rehydrate({
      consumerName: "c",
      messageId: "m",
      payloadHash: "h",
      receivedAt: T1,
      processedAt: T0,
    });
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(T0);
    expect(message.receivedAt).toEqual(T1);
  });

  it("§6.0 D24: rehydrate de uma linha não processada", () => {
    const message = InboxMessage.rehydrate({
      consumerName: "c",
      messageId: "m",
      payloadHash: "h",
      receivedAt: T0,
      processedAt: undefined,
    });
    expect(message.isProcessed()).toBe(false);
  });
});
