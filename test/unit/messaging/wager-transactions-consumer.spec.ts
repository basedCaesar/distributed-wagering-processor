import { describe, expect, it } from "bun:test";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import type { Logger } from "pino";
import type { SubmitWagerTransactionUseCase } from "../../../src/modules/wagering/application/submit-wager-transaction.use-case";
import { receiveBackoffMs } from "../../../src/modules/wagering/infra/messaging/consumer-policy";
import {
  type SqsCommand,
  type SqsSender,
  SqsWagerQueue,
} from "../../../src/modules/wagering/infra/messaging/sqs-wager-queue";
import {
  abortableDelay,
  type ConsumerDeps,
  WagerTransactionsConsumer,
} from "../../../src/modules/wagering/infra/messaging/wager-transactions-consumer";
import type { MessageAttemptsRecorder } from "../../../src/modules/wagering/infra/persistence/message-attempts";

const URLS = { queueUrl: "http://sqs/main.fifo", dlqUrl: "http://sqs/dlq.fifo" };

/** Logger que guarda nível e mensagem de cada linha. */
function fakeLogger() {
  const lines: { level: string; msg: string }[] = [];
  const at = (level: string) => (_fields: unknown, msg?: string) => {
    lines.push({ level, msg: msg ?? String(_fields) });
  };
  const logger = { info: at("info"), warn: at("warn"), error: at("error") } as unknown as Logger;
  return { logger, lines };
}

const noAttempts: MessageAttemptsRecorder = {
  record: async () => 1,
  clear: async () => {},
};

function consumerWith(client: SqsSender, deps: Partial<ConsumerDeps> = {}, policy = {}) {
  const { logger, lines } = fakeLogger();
  const consumer = new WagerTransactionsConsumer(
    {
      queue: new SqsWagerQueue(client, URLS),
      // Os casos daqui nunca chegam ao use case (receive falha ou JSON quebrado).
      submit: {} as SubmitWagerTransactionUseCase,
      attempts: noAttempts,
      logger,
      currencies: ["BRL"],
      ...deps,
    },
    { consumerName: "consumer-unit", ...policy },
  );
  return { consumer, lines };
}

/** Mensagem com JSON quebrado: permanente, vai direto para a DLQ (D8.2). */
const broken = (id: string) => ({
  MessageId: `sqs-${id}`,
  ReceiptHandle: `rh-${id}`,
  Body: `{ quebrada ${id}`,
  Attributes: { MessageGroupId: "group-1", MessageDeduplicationId: `d-${id}`, ApproximateReceiveCount: "1" },
});

describe("D19.10: espera entre receives que falham", () => {
  it("D19.10: 1 s, dobrando até 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => receiveBackoffMs(n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });

  it("D19.10: o laço espera a cada falha do SQS, dobra até 30 s e volta a 1 s depois de um receive bem-sucedido", async () => {
    // 7 falhas, 1 receive vazio, 1 falha; a 10ª chamada fica parada até o teste parar o laço.
    const script = ["fail", "fail", "fail", "fail", "fail", "fail", "fail", "ok", "fail"];
    let calls = 0;
    let reachedEnd: (() => void) | undefined;
    const end = new Promise<void>((resolve) => {
      reachedEnd = resolve;
    });
    let failLast: ((error: Error) => void) | undefined;
    const client: SqsSender = {
      async send(command: SqsCommand) {
        if (!(command instanceof ReceiveMessageCommand)) throw new Error("só receive aqui");
        const step = script[calls++];
        if (step === "ok") return { Messages: [] };
        if (step === "fail") throw Object.assign(new Error("SQS fora"), { code: "ECONNREFUSED" });
        reachedEnd?.();
        return new Promise((_, reject) => {
          failLast = reject;
        });
      },
    };
    const waits: number[] = [];
    const { consumer } = consumerWith(client, {
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    consumer.start();
    await end;
    const stopping = consumer.stop();
    failLast?.(new Error("SQS fora"));
    await stopping;

    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 1_000]);
    // Parado durante o receive que falhou: não espera de novo nem faz outro receive.
    expect(calls).toBe(10);
  });

  it("D19.10 D8.5: o stop() interrompe a espera na hora", async () => {
    let waiting: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const client: SqsSender = {
      async send() {
        throw Object.assign(new Error("SQS fora"), { code: "ECONNREFUSED" });
      },
    };
    const { consumer } = consumerWith(
      client,
      {
        wait: (ms, signal) => {
          waiting?.();
          return abortableDelay(ms, signal);
        },
      },
      // Uma espera de 60 s: só o stop() a termina dentro do prazo do teste.
      { receiveBackoffInitialMs: 60_000 },
    );

    consumer.start();
    await entered;
    const started = Date.now();
    await consumer.stop();

    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("D19.6: cópia para a DLQ", () => {
  /** Cliente que entrega `messages` uma vez e falha no comando `failOn`. */
  function clientFor(messages: ReturnType<typeof broken>[], failOn: string) {
    const sent: { name: string; receiptHandle?: string; visibility?: number }[] = [];
    let delivered = false;
    const client: SqsSender = {
      async send(command: SqsCommand) {
        const name = command.constructor.name;
        const input = command.input as { ReceiptHandle?: string; VisibilityTimeout?: number };
        sent.push({ name, receiptHandle: input.ReceiptHandle, visibility: input.VisibilityTimeout });
        if (command instanceof ReceiveMessageCommand) {
          const batch = delivered ? [] : messages;
          delivered = true;
          return { Messages: batch };
        }
        if (name === failOn) throw Object.assign(new Error(`${name} falhou`), { code: "ECONNRESET" });
        return {};
      },
    };
    return { client, sent };
  }

  it("D19.6: a cópia falhou → 'cópia para a DLQ falhou'; as seguintes do grupo voltam com visibilidade 0, sem processar", async () => {
    const { client, sent } = clientFor([broken("1"), broken("2")], SendMessageCommand.name);
    const { consumer, lines } = consumerWith(client);

    expect(await consumer.pollOnce()).toEqual(["unresolved", "released"]);

    expect(sent.slice(1)).toEqual([
      { name: SendMessageCommand.name, receiptHandle: undefined, visibility: undefined },
      { name: ChangeMessageVisibilityCommand.name, receiptHandle: "rh-2", visibility: 0 },
    ]);
    expect(lines).toContainEqual({ level: "error", msg: "cópia para a DLQ falhou; a mensagem continua na fila" });
  });

  it("D19.6: cópia enviada e delete falhou → log próprio, distinto da cópia que falhou; o grupo segue", async () => {
    const { client, sent } = clientFor([broken("1"), broken("2")], DeleteMessageCommand.name);
    const { consumer, lines } = consumerWith(client);

    expect(await consumer.pollOnce()).toEqual(["dead_letter_not_deleted", "dead_letter_not_deleted"]);

    expect(sent.filter((c) => c.name === SendMessageCommand.name)).toHaveLength(2);
    expect(lines.filter((l) => l.level === "error").map((l) => l.msg)).toEqual([
      "cópia enviada para a DLQ, mas o delete falhou; a mensagem volta quando a visibilidade vencer",
      "cópia enviada para a DLQ, mas o delete falhou; a mensagem volta quando a visibilidade vencer",
    ]);
  });
});
