import { describe, expect, it } from "bun:test";
import { DeleteMessageCommand, type Message, ReceiveMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import pino from "pino";
import { type RealtimeConnection, RealtimeHub } from "../../../src/modules/realtime/application/realtime-hub";
import type { RealtimeEvent } from "../../../src/modules/realtime/domain/realtime-event";
import { RealtimeEventLoop } from "../../../src/modules/realtime/infra/messaging/realtime-event-loop";
import { metricValue } from "../../support/metrics";
import { waitFor } from "../../support/processes";

const WALLET = "0190f5b8-0000-7000-8000-0000000000e1";
const silent = pino({ level: "silent" });

/** Um `WalletBalanceChanged` do §11 como chega na fila da instância (`RawMessageDelivery`). */
function message(walletVersion: number): Message {
  const eventId = Bun.randomUUIDv7();
  return {
    MessageId: eventId,
    ReceiptHandle: `rh-${eventId}`,
    Attributes: { SentTimestamp: String(Date.now()) },
    Body: JSON.stringify({
      eventId,
      eventType: "WalletBalanceChanged",
      aggregateId: WALLET,
      correlationId: `corr-${eventId}`,
      occurredAt: new Date().toISOString(),
      version: 1,
      data: {
        walletId: WALLET,
        transactionId: Bun.randomUUIDv7(),
        direction: "CREDIT",
        money: { amount: "1.00", currency: "BRL" },
        balanceBefore: { amount: `${walletVersion - 1}.00`, currency: "BRL" },
        balanceAfter: { amount: `${walletVersion}.00`, currency: "BRL" },
        walletVersion,
      },
    }),
  };
}

/**
 * SQS controlado pelo teste: cada receive espera o teste entregar um lote
 * (`deliver`), e cada delete espera o teste soltá-lo (`deletes[i].done()`).
 */
class ControlledSqs {
  readonly receives: ((messages: Message[]) => void)[] = [];
  readonly deletes: { handle: string | undefined; done: () => void }[] = [];

  async send(command: unknown): Promise<unknown> {
    if (command instanceof ReceiveMessageCommand) {
      const Messages = await new Promise<Message[]>((resolve) => this.receives.push(resolve));
      return { Messages };
    }
    if (command instanceof DeleteMessageCommand) {
      await new Promise<void>((done) => this.deletes.push({ handle: command.input.ReceiptHandle, done }));
      return {};
    }
    throw new Error("comando inesperado no SQS do teste");
  }

  /** Responde o receive em andamento. */
  deliver(messages: Message[]): void {
    const resolve = this.receives.shift();
    if (resolve === undefined) throw new Error("nenhum receive em andamento");
    resolve(messages);
  }

  asClient(): SQSClient {
    return this as unknown as SQSClient;
  }
}

function setup() {
  const sqs = new ControlledSqs();
  const received: RealtimeEvent[] = [];
  const follower: RealtimeConnection = { viewer: { roles: new Set(["operator"]) }, deliver: (event) => received.push(event) };
  const hub = new RealtimeHub({
    maxFollowsPerConnection: 50,
    onDeliveryFailure: (error) => {
      throw error;
    },
  });
  hub.follow(follower, WALLET);
  const loop = new RealtimeEventLoop({ sqs: sqs.asClient(), queueUrl: "fila-do-teste", hub, logger: silent, startedAt: 0, receiveWaitSeconds: 1 });
  return { sqs, received, loop };
}

/** Para o laço: o receive em andamento termina vazio (o long poll não é abortado, D28.5). */
async function stop(sqs: ControlledSqs, loop: RealtimeEventLoop): Promise<void> {
  const stopping = loop.stop();
  for (const resolve of sqs.receives.splice(0)) resolve([]);
  await stopping;
}

describe("D28.7 D28.8: laço sequencial da fila da instância", () => {
  it("D28.7 D28.8: a 2ª mensagem do lote só é processada depois que o delete da 1ª termina", async () => {
    const { sqs, received, loop } = setup();
    const first = message(2);
    const second = message(3);
    loop.start();
    await waitFor(() => sqs.receives.length === 1, "1º receive", 2000);

    sqs.deliver([first, second]);
    await waitFor(() => sqs.deletes.length >= 1, "delete da 1ª em andamento", 2000);

    // O delete da 1ª ainda não terminou: a 2ª não foi entregue nem apagada.
    expect(received.map((event) => event.eventId)).toEqual([first.MessageId as string]);
    expect(sqs.deletes.map((d) => d.handle)).toEqual([first.ReceiptHandle]);

    sqs.deletes[0]?.done();
    await waitFor(() => sqs.deletes.length === 2, "delete da 2ª em andamento", 2000);

    expect(received.map((event) => event.eventId)).toEqual([first.MessageId as string, second.MessageId as string]);
    sqs.deletes[1]?.done();
    await waitFor(() => sqs.receives.length === 1, "receive seguinte", 2000);
    await stop(sqs, loop);
  });

  it("D28.5 D28.11: o que o long poll traz durante o stop é apagado sem envio, com outcome shutdown (não stale)", async () => {
    const { sqs, received, loop } = setup();
    const shutdownBefore = await metricValue("realtime_events_total", { outcome: "shutdown" });
    const staleBefore = await metricValue("realtime_events_total", { outcome: "stale" });
    loop.start();
    await waitFor(() => sqs.receives.length === 1, "1º receive", 2000);

    const stopping = loop.stop();
    const late = message(2);
    sqs.deliver([late]);
    await waitFor(() => sqs.deletes.length === 1, "delete da mensagem do stop", 2000);
    sqs.deletes[0]?.done();
    await stopping;

    expect(received).toEqual([]);
    expect(sqs.deletes.map((d) => d.handle)).toEqual([late.ReceiptHandle]);
    expect((await metricValue("realtime_events_total", { outcome: "shutdown" })) - shutdownBefore).toBe(1);
    expect((await metricValue("realtime_events_total", { outcome: "stale" })) - staleBefore).toBe(0);
  });
});
