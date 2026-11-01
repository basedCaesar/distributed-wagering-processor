import type { Logger } from "pino";
import { type ClassifiedError, classifyError } from "../../../../shared/errors/classify-error";
import { type RequestContext, runWithContext } from "../../../../shared/logger/request-context";
import type { MessageAttemptsRecorder } from "../persistence/message-attempts";
import {
  attemptsExhausted,
  backoffSeconds,
  CONSUMER_POLICY,
  type ConsumerPolicy,
  dispositionOf,
  receiveBackoffMs,
} from "./consumer-policy";
import { DeadLetterDeleteError, type QueueMessage, type SqsWagerQueue } from "./sqs-wager-queue";

/**
 * O que aconteceu com cada mensagem:
 * - `processed`: o efeito commitou e houve ack (R-10-05, D8.2);
 * - `duplicate`: a inbox já tinha a mensagem; ack sem efeito (D19.4);
 * - `dead_lettered`: copiada para a DLQ e apagada (D8.2, D19.6);
 * - `dead_letter_not_deleted`: copiada para a DLQ, mas o delete da fila
 *   falhou; ela volta quando a visibilidade vencer e vai de novo para a DLQ;
 * - `retry_scheduled`: sem ack, com a visibilidade do backoff (D8.2);
 * - `released`: não processada (no `stop()`, D8.5, ou atrás de uma do mesmo
 *   grupo que ficou na fila, D19.6); devolvida com visibilidade 0;
 * - `ack_failed`: commitou, mas o ack falhou; a reentrega cai na inbox;
 * - `unresolved`: nem a DLQ nem a visibilidade responderam; a visibilidade
 *   do receive vence e a mensagem volta.
 */
export type MessageOutcome =
  | "processed"
  | "duplicate"
  | "dead_lettered"
  | "dead_letter_not_deleted"
  | "retry_scheduled"
  | "released"
  | "ack_failed"
  | "unresolved";

/**
 * A mensagem continua na fila sem efeito (retry, ou DLQ/visibilidade que
 * falharam): as seguintes do mesmo grupo neste lote não podem passar na
 * frente dela (D19.6).
 */
const HOLDS_GROUP: ReadonlySet<MessageOutcome> = new Set(["retry_scheduled", "unresolved"]);

/** Espera `ms` ou até o `signal` abortar, o que vier primeiro (D19.10). */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Uma mensagem já validada, pronta para o efeito. */
export interface ParsedMessage {
  /** Chave da inbox e do `message_attempts` com o `consumerName` (D3.7). */
  messageId: string;
  /** Contexto dos logs (D11.1): só ids. */
  context: RequestContext;
  /** O efeito, numa transação com a inbox; `duplicate` se ela já tinha a mensagem. */
  process(): Promise<"processed" | "duplicate">;
}

/** Corpo → mensagem validada. Lança o erro de validação (permanente, DLQ). */
export type MessageParser = (body: string) => ParsedMessage;

export interface SqsConsumerDeps {
  queue: SqsWagerQueue;
  attempts: MessageAttemptsRecorder;
  logger: Logger;
  /** Espera entre receives que falham (D19.10); os testes a trocam. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Laço genérico de um consumidor SQS FIFO com inbox (D8, D19, D20.2), usado
 * pelo consumidor das transações e pelo auditor dos eventos. Só dá ack
 * depois do efeito (R-10-05). Erros passam por `classifyError()` e viram
 * ack, DLQ ou retry (D8.2). Tentativas contadas em `message_attempts`,
 * nunca pelo `ApproximateReceiveCount` (D8.3), e apagadas no ack e na DLQ
 * (D19.11); com o banco fora, o redrive é o limite (D19.3).
 *
 * No lote, as mensagens de um `MessageGroupId` vão em sequência, e grupos
 * diferentes em paralelo. Se uma fica na fila (retry), as seguintes do
 * grupo voltam com visibilidade 0 sem processar (D19.6). Receive que falha:
 * espera de 1 s, dobrando até 30 s (D19.10). `stop()` (`SIGTERM`, D8.5,
 * D19.9): espera o long poll em andamento, termina as mensagens em
 * andamento em até 20 s e devolve com visibilidade 0 as não iniciadas e as
 * que o último receive trouxer.
 *
 * Logs sem valores, saldos, payload nem `playerId` (D11.1).
 */
export class SqsConsumer {
  protected readonly policy: ConsumerPolicy;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private running = false;
  private stopping = false;
  private loop: Promise<void> | undefined;
  private stopSignal: AbortController | undefined;

  constructor(
    private readonly deps: SqsConsumerDeps,
    private readonly parse: MessageParser,
    policy: Partial<ConsumerPolicy> = {},
  ) {
    this.policy = { ...CONSUMER_POLICY, ...policy };
    this.wait = deps.wait ?? abortableDelay;
  }

  /**
   * Um receive e o lote inteiro. Devolve o resultado de cada mensagem, em
   * ordem de grupo. Se o `stop()` chegou durante o long poll, tudo o que
   * ele trouxer é devolvido sem processar (D19.9).
   */
  async pollOnce(): Promise<MessageOutcome[]> {
    const messages = await this.deps.queue.receive({
      maxMessages: this.policy.maxMessages,
      waitTimeSeconds: this.policy.waitTimeSeconds,
      visibilityTimeoutSeconds: this.policy.visibilityTimeoutSeconds,
    });
    const groups = new Map<string, QueueMessage[]>();
    for (const message of messages) {
      const group = groups.get(message.groupId) ?? [];
      group.push(message);
      groups.set(message.groupId, group);
    }
    const outcomes = await Promise.all([...groups.values()].map((group) => this.handleGroup(group)));
    return outcomes.flat();
  }

  start(): void {
    if (this.loop) return;
    this.running = true;
    this.stopping = false;
    this.stopSignal = new AbortController();
    this.loop = this.run(this.stopSignal.signal);
  }

  /**
   * `SIGTERM` (D8.5, D19.9): não começa outro receive e interrompe na hora
   * a espera entre receives que falharam (D19.10). O long poll em andamento
   * **não é abortado**: abortar fecha só a conexão do cliente, e o receive
   * continua aberto no servidor, prendendo por 120 s o que chegar. Ele
   * termina (até 20 s), e o que trouxer volta com visibilidade 0, sem
   * processar. Um lote em andamento termina a mensagem atual de cada grupo
   * e devolve as não iniciadas. Passado o prazo, volta mesmo assim: o que
   * estiver sem commit é desfeito com o processo, e a mensagem volta quando
   * a visibilidade vencer.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    this.stopSignal?.abort();
    if (!this.loop) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.policy.shutdownGraceMs + this.policy.releaseMarginMs);
    });
    await Promise.race([this.loop, grace]);
    clearTimeout(timer);
    this.loop = undefined;
  }

  /** O laço: receive após receive; depois de uma falha, espera (D19.10). */
  private async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (this.running) {
      try {
        await this.pollOnce();
        failures = 0;
      } catch (error) {
        const { category, code } = classifyError(error);
        if (!this.running) {
          this.deps.logger.warn({ category, code }, "receive da fila falhou durante o stop");
          break;
        }
        failures += 1;
        const delayMs = receiveBackoffMs(
          failures,
          this.policy.receiveBackoffInitialMs,
          this.policy.receiveBackoffMaxMs,
        );
        this.deps.logger.warn({ category, code, failures, delayMs }, "receive da fila falhou; nova tentativa depois da espera");
        await this.wait(delayMs, signal);
      }
    }
  }

  private async handleGroup(group: QueueMessage[]): Promise<MessageOutcome[]> {
    const outcomes: MessageOutcome[] = [];
    let held = false;
    for (const message of group) {
      if (this.stopping || held) {
        outcomes.push(await this.release(message));
        continue;
      }
      const outcome = await this.handle(message);
      outcomes.push(outcome);
      held = HOLDS_GROUP.has(outcome);
    }
    return outcomes;
  }

  private async handle(message: QueueMessage): Promise<MessageOutcome> {
    let parsed: ParsedMessage;
    try {
      parsed = this.parse(message.body);
    } catch (error) {
      return this.fail(message, undefined, classifyError(error));
    }
    const { messageId } = parsed;
    return runWithContext(parsed.context, async () => {
      let result: "processed" | "duplicate";
      try {
        result = await parsed.process();
      } catch (error) {
        return this.fail(message, messageId, classifyError(error));
      }
      // Ack só depois do commit (R-10-05).
      try {
        await this.deps.queue.ack(message);
      } catch (error) {
        const { category, code } = classifyError(error);
        this.deps.logger.warn({ category, code }, "ack falhou depois do commit; a reentrega cai na inbox");
        return "ack_failed";
      }
      await this.clearAttempts(messageId);
      if (result === "duplicate") this.deps.logger.info("mensagem duplicada (inbox)");
      return result;
    });
  }

  /** Permanente → DLQ; transitório e interno → retry contado (D8.2, D19.1, D19.2). */
  private async fail(
    message: QueueMessage,
    messageId: string | undefined,
    error: ClassifiedError,
  ): Promise<MessageOutcome> {
    const { category, code } = error;
    if (dispositionOf(category) === "dead_letter" || messageId === undefined) {
      this.deps.logger.warn({ category, code, sqsMessageId: message.sqsMessageId }, "mensagem permanente → DLQ");
      return this.deadLetter(message, messageId);
    }
    let attempts: number;
    try {
      attempts = await this.deps.attempts.record(this.policy.consumerName, messageId, code);
    } catch (recordError) {
      // Banco fora: sem onde contar. O atraso sai do ApproximateReceiveCount,
      // o limite fica com o redrive da fila (D19.3).
      const classified = classifyError(recordError);
      this.deps.logger.warn(
        { category, code, recordCategory: classified.category, receiveCount: message.receiveCount },
        "tentativa não registrada; o redrive da fila é o limite",
      );
      return this.retry(message, backoffSeconds(message.receiveCount, this.policy.backoffMaxSeconds));
    }
    if (attemptsExhausted(attempts, this.policy.maxAttempts)) {
      this.deps.logger.warn({ category, code, attempts }, "tentativas esgotadas → DLQ");
      return this.deadLetter(message, messageId);
    }
    this.deps.logger.warn({ category, code, attempts }, "falha transitória; retry com backoff");
    return this.retry(message, backoffSeconds(attempts, this.policy.backoffMaxSeconds));
  }

  private async deadLetter(message: QueueMessage, messageId: string | undefined): Promise<MessageOutcome> {
    try {
      await this.deps.queue.deadLetter(message);
    } catch (error) {
      if (error instanceof DeadLetterDeleteError) {
        // As tentativas ficam: na volta, a 1ª falha transitória já esgota o
        // limite e a mensagem vai de novo para a DLQ (deduplicada).
        const { category, code } = classifyError(error.cause);
        this.deps.logger.error(
          { category, code },
          "cópia enviada para a DLQ, mas o delete falhou; a mensagem volta quando a visibilidade vencer",
        );
        return "dead_letter_not_deleted";
      }
      const { category, code } = classifyError(error);
      this.deps.logger.error({ category, code }, "cópia para a DLQ falhou; a mensagem continua na fila");
      return "unresolved";
    }
    if (messageId !== undefined) await this.clearAttempts(messageId);
    return "dead_lettered";
  }

  /**
   * Apaga as tentativas depois do ack ou da DLQ (D19.11). Se falhar, a
   * linha fica: só pesa se a mensagem voltar da DLQ para a fila.
   */
  private async clearAttempts(messageId: string): Promise<void> {
    try {
      await this.deps.attempts.clear(this.policy.consumerName, messageId);
    } catch (error) {
      const { category, code } = classifyError(error);
      this.deps.logger.warn({ category, code }, "tentativas não apagadas depois do ack ou da DLQ");
    }
  }

  private async retry(message: QueueMessage, seconds: number): Promise<MessageOutcome> {
    try {
      await this.deps.queue.changeVisibility(message, seconds);
      return "retry_scheduled";
    } catch (error) {
      const { category, code } = classifyError(error);
      this.deps.logger.error({ category, code }, "backoff não aplicado; a visibilidade do receive vence");
      return "unresolved";
    }
  }

  /**
   * Não processada: volta para a fila na hora. No `stop()` (D8.5) ou atrás
   * de uma mensagem do mesmo grupo que ficou na fila (D19.6).
   */
  private async release(message: QueueMessage): Promise<MessageOutcome> {
    try {
      await this.deps.queue.changeVisibility(message, 0);
      return "released";
    } catch (error) {
      const { category, code } = classifyError(error);
      this.deps.logger.warn({ category, code }, "devolução falhou; a visibilidade do receive vence");
      return "unresolved";
    }
  }
}
