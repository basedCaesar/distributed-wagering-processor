import type { Logger } from "pino";
import { type ClassifiedError, classifyError } from "../../../../shared/errors/classify-error";
import { runWithContext } from "../../../../shared/logger/request-context";
import type { SubmitWagerTransactionUseCase } from "../../application/submit-wager-transaction.use-case";
import type { MessageAttemptsRecorder } from "../persistence/message-attempts";
import {
  attemptsExhausted,
  backoffSeconds,
  CONSUMER_POLICY,
  type ConsumerPolicy,
  dispositionOf,
} from "./consumer-policy";
import type { QueueMessage, SqsWagerQueue } from "./sqs-wager-queue";
import { parseWagerMessage } from "./wager-message.schema";

/**
 * O que aconteceu com cada mensagem:
 * - `processed`: o use case commitou (aplicada, rejeitada, pendente ou
 *   replay) e houve ack (R-10-05, D8.2);
 * - `duplicate`: a inbox já tinha a mensagem; ack sem efeito (D19.4);
 * - `dead_lettered`: copiada para a DLQ e apagada (D8.2, D19.6);
 * - `retry_scheduled`: sem ack, com a visibilidade do backoff (D8.2);
 * - `released`: não iniciada no `stop()`; devolvida com visibilidade 0 (D8.5);
 * - `ack_failed`: commitou, mas o ack falhou; a reentrega cai na inbox;
 * - `unresolved`: nem a DLQ nem a visibilidade responderam; a visibilidade
 *   do receive vence e a mensagem volta.
 */
export type MessageOutcome =
  | "processed"
  | "duplicate"
  | "dead_lettered"
  | "retry_scheduled"
  | "released"
  | "ack_failed"
  | "unresolved";

export interface ConsumerDeps {
  queue: SqsWagerQueue;
  submit: SubmitWagerTransactionUseCase;
  attempts: MessageAttemptsRecorder;
  logger: Logger;
  /** Lista de moedas aceitas (D2.5): o mesmo schema do HTTP. */
  currencies: readonly string[];
}

/**
 * Consumidor da `wager-transactions.fifo` (R-10-*, D8, D19). Chama o mesmo
 * use case do HTTP com a inbox (R-10-03, D19.4) e só dá ack depois do
 * commit (R-10-05). Erros passam por `classifyError()` e viram ack, DLQ ou
 * retry (D8.2). Tentativas contadas em `message_attempts`, nunca pelo
 * `ApproximateReceiveCount` (D8.3); com o banco fora, o redrive é o
 * limite (D19.3).
 *
 * No lote, as mensagens de um `MessageGroupId` vão em sequência, e grupos
 * diferentes em paralelo (D19.6). `stop()` (`SIGTERM`, D8.5, D19.9):
 * espera o long poll em andamento, termina as mensagens em andamento em
 * até 20 s e devolve com visibilidade 0 as não iniciadas e as que o último
 * receive trouxer.
 *
 * Logs sem valores, saldos, payload nem `playerId` (D11.1).
 */
export class WagerTransactionsConsumer {
  private readonly policy: ConsumerPolicy;
  private running = false;
  private stopping = false;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly deps: ConsumerDeps,
    policy: Partial<ConsumerPolicy> = {},
  ) {
    this.policy = { ...CONSUMER_POLICY, ...policy };
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
    this.loop = this.run();
  }

  /**
   * `SIGTERM` (D8.5, D19.9): não começa outro receive. O long poll em
   * andamento **não é abortado**: abortar fecha só a conexão do cliente, e
   * o receive continua aberto no servidor, prendendo por 120 s o que
   * chegar. Ele termina (até 20 s), e o que trouxer volta com visibilidade
   * 0, sem processar. Um lote em andamento termina a mensagem atual de
   * cada grupo e devolve as não iniciadas. Passado o prazo, volta mesmo
   * assim: o que estiver sem commit é desfeito com o processo, e a
   * mensagem volta quando a visibilidade vencer.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    if (!this.loop) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.policy.shutdownGraceMs + this.policy.releaseMarginMs);
    });
    await Promise.race([this.loop, grace]);
    clearTimeout(timer);
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        const { category, code } = classifyError(error);
        this.deps.logger.warn({ category, code }, "receive da fila falhou");
      }
    }
  }

  private async handleGroup(group: QueueMessage[]): Promise<MessageOutcome[]> {
    const outcomes: MessageOutcome[] = [];
    for (const message of group) {
      outcomes.push(this.stopping ? await this.release(message) : await this.handle(message));
    }
    return outcomes;
  }

  private async handle(message: QueueMessage): Promise<MessageOutcome> {
    let parsed: ReturnType<typeof parseWagerMessage>;
    try {
      parsed = parseWagerMessage(message.body, this.deps.currencies);
    } catch (error) {
      return this.fail(message, undefined, classifyError(error));
    }
    const { messageId, command } = parsed;
    const context = {
      correlationId: messageId,
      messageId,
      walletId: command.walletId,
      providerId: command.providerId,
    };
    return runWithContext(context, async () => {
      let duplicate: boolean;
      try {
        // correlationId e causationId = o messageId do corpo (D9.5).
        const result = await this.deps.submit.execute(
          command,
          { correlationId: messageId, causationId: messageId },
          { consumerName: this.policy.consumerName, messageId, type: parsed.type },
        );
        duplicate = "duplicateMessage" in result;
        if (!duplicate && "transaction" in result) {
          this.deps.logger.info(
            { transactionId: result.transaction.id, status: result.transaction.status, replay: result.idempotentReplay },
            "mensagem processada",
          );
        }
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
      if (duplicate) this.deps.logger.info("mensagem duplicada (inbox)");
      return duplicate ? "duplicate" : "processed";
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
      return this.deadLetter(message);
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
      return this.deadLetter(message);
    }
    this.deps.logger.warn({ category, code, attempts }, "falha transitória; retry com backoff");
    return this.retry(message, backoffSeconds(attempts, this.policy.backoffMaxSeconds));
  }

  private async deadLetter(message: QueueMessage): Promise<MessageOutcome> {
    try {
      await this.deps.queue.deadLetter(message);
      return "dead_lettered";
    } catch (error) {
      const { category, code } = classifyError(error);
      this.deps.logger.error({ category, code }, "cópia para a DLQ falhou; a mensagem continua na fila");
      return "unresolved";
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

  /** Recebida e não iniciada no `stop()`: volta para a fila na hora (D8.5). */
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
