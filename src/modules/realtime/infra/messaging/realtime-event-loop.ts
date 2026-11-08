import { DeleteMessageCommand, type Message, ReceiveMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { Logger } from "pino";
import { receiveTimeoutMs } from "../../../../shared/aws/sqs-client";
import { classifyError } from "../../../../shared/errors/classify-error";
import { type RealtimeEventOutcome, realtimeEventsTotal } from "../../../../shared/metrics/metrics";
import type { RealtimeHub } from "../../application/realtime-hub";
import { parseRealtimeEvent } from "./realtime-envelope";

/** Espera depois de um receive que falhou (D28.7). */
const RECEIVE_RETRY_MS = 1000;

export interface RealtimeEventLoopDeps {
  sqs: SQSClient;
  queueUrl: string;
  hub: RealtimeHub;
  logger: Logger;
  /**
   * Início da instância (ms desde a época), guardado antes de resolver a
   * fila e abrir a porta: o que foi enviado à fila antes disso é descartado
   * (D28.6).
   */
  startedAt: number;
  receiveWaitSeconds: number;
}

/**
 * O laço da fila da instância (D28.7): sequencial, então a ordem do FIFO
 * por `walletId` chega igual aos sockets. Para cada mensagem: descarte por
 * idade, parse, envio aos sockets locais, delete. Sem inbox, sem
 * tentativas, sem DLQ: notificação efêmera (a exceção registrada na
 * D28.7).
 */
export class RealtimeEventLoop {
  private loop: Promise<void> | undefined;
  private running = false;
  private wake: (() => void) | undefined;

  constructor(private readonly deps: RealtimeEventLoopDeps) {}

  start(): void {
    if (this.loop) return;
    this.running = true;
    this.loop = this.run();
  }

  /**
   * Não começa outro receive. O long poll em andamento **não é abortado**
   * (D28.5, como a D19.9): abortar deixaria o receive aberto no servidor,
   * prendendo o que chegar. Ele termina, e o que trouxer é apagado sem envio.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let messages: Message[];
      try {
        messages = await this.receive();
      } catch (error) {
        const { category, code } = classifyError(error);
        if (!this.running) {
          this.deps.logger.warn({ category, code }, "receive da fila do realtime falhou durante o stop");
          break;
        }
        this.deps.logger.warn({ category, code, delayMs: RECEIVE_RETRY_MS }, "receive da fila do realtime falhou; nova tentativa");
        await this.pause(RECEIVE_RETRY_MS);
        continue;
      }
      for (const message of messages) await this.handle(message);
    }
  }

  private async receive(): Promise<Message[]> {
    const { Messages } = await this.deps.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.deps.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.deps.receiveWaitSeconds,
        MessageSystemAttributeNames: ["SentTimestamp"],
      }),
      { requestTimeout: receiveTimeoutMs(this.deps.receiveWaitSeconds) },
    );
    return Messages ?? [];
  }

  private async handle(message: Message): Promise<void> {
    const outcome = this.forward(message);
    realtimeEventsTotal.inc({ outcome });
    try {
      await this.deps.sqs.send(new DeleteMessageCommand({ QueueUrl: this.deps.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    } catch (error) {
      // A mensagem volta depois da visibilidade e pode chegar duplicada: o cliente descarta (D28.8).
      const { category, code } = classifyError(error);
      this.deps.logger.warn({ category, code, outcome }, "delete da fila do realtime falhou");
    }
  }

  /** Decide e entrega. Nenhum valor do corpo vai para o log (D11.1). */
  private forward(message: Message): RealtimeEventOutcome {
    // Trazido pelo long poll que terminou durante o stop: apagado sem envio (D28.5).
    if (!this.running) return "shutdown";
    const sentAt = Number.parseInt(message.Attributes?.SentTimestamp ?? "", 10);
    if (!Number.isFinite(sentAt) || sentAt < this.deps.startedAt) return "stale";
    try {
      const event = parseRealtimeEvent(message.Body ?? "");
      if (event === null) return "ignored";
      this.deps.hub.dispatch(event);
      return "forwarded";
    } catch (error) {
      const { category, code } = classifyError(error);
      this.deps.logger.warn({ category, code }, "evento inválido na fila do realtime; apagado sem envio (D28.7)");
      return "invalid";
    }
  }

  /** Espera interrompível pelo `stop()`. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}
