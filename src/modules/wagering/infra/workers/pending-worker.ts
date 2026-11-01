import type { Logger } from "pino";
import { classifyError } from "../../../../shared/errors/classify-error";
import { runWithContext } from "../../../../shared/logger/request-context";
import { PENDING_POLICY } from "../../application/pending-policy";
import type { ClaimedPending, PendingQueue } from "../../application/ports";
import type { ResolvePendingTransactionUseCase } from "../../application/resolve-pending-transaction.use-case";

export interface PendingWorkerOptions {
  batchSize: number;
  leaseMs: number;
  tickMs: number;
}

const DEFAULT_OPTIONS: PendingWorkerOptions = {
  batchSize: PENDING_POLICY.batchSize,
  leaseMs: PENDING_POLICY.leaseMs,
  tickMs: PENDING_POLICY.tickMs,
};

/**
 * Worker agendado das `PENDING_REFERENCE` (R-07-20, D4.3). A cada tick:
 * claim curto e commitado com lease (`SKIP LOCKED`), depois uma tentativa
 * por item, em ordem (D18.9), cada uma na sua transação. Lote cheio: vai
 * direto para o próximo, sem esperar o tick.
 *
 * Todo erro passa por `classifyError()` (CLAUDE.md). Erro numa tentativa:
 * a tentativa foi desfeita e o erro é registrado numa transação própria
 * (D18.4). Se nem isso der, o lease vence sozinho e outra rodada tenta.
 *
 * Logs sem valores, saldos nem payload (D11.1).
 */
export class PendingWorker {
  private readonly options: PendingWorkerOptions;
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly queue: PendingQueue,
    private readonly useCase: ResolvePendingTransactionUseCase,
    private readonly logger: Logger,
    options: Partial<PendingWorkerOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Um claim e as tentativas do lote. Devolve o que foi pego. */
  async runOnce(): Promise<ClaimedPending[]> {
    const claimed = await this.queue.claimDue(this.options.batchSize, this.options.leaseMs);
    for (const item of claimed) {
      // stop(): termina o item atual; os outros ficam com o lease, que vence (D18.8).
      if (this.loop !== undefined && !this.running) break;
      await this.handle(item);
    }
    return claimed;
  }

  start(): void {
    if (this.loop) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Para de buscar, termina o item atual e espera o laço sair (D8.6, D18.8). */
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
        claimed = (await this.runOnce()).length;
      } catch (error) {
        const { category, code } = classifyError(error);
        this.logger.warn({ category, code }, "claim de pendentes falhou");
      }
      if (this.running && claimed < this.options.batchSize) {
        await this.pause();
      }
    }
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(resolve, this.options.tickMs);
    });
  }

  private handle(item: ClaimedPending): Promise<void> {
    return runWithContext({ transactionId: item.id, walletId: item.walletId }, async () => {
      try {
        const result = await this.useCase.attempt(item);
        this.logger.debug({ result: result.kind }, "tentativa da pendente concluída");
        return;
      } catch (error) {
        const { category, code } = classifyError(error);
        this.logger.warn({ category, code }, "tentativa da pendente falhou");
        await this.record(item, category === "transient");
      }
    });
  }

  private async record(item: ClaimedPending, transient: boolean): Promise<void> {
    try {
      const result = await this.useCase.recordError(item, { transient });
      if (result.kind === "resolved") {
        this.logger.error({ status: result.status }, "pendente marcada FAILED depois de erros seguidos");
      }
    } catch (error) {
      const { category, code } = classifyError(error);
      this.logger.error({ category, code }, "erro da pendente não registrado; o lease vence sozinho");
    }
  }
}
