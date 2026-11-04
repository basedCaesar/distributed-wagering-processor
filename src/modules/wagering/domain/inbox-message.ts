import { InvalidInboxTransitionError } from "./domain-error";

export interface ReceiveInboxProps {
  consumerName: string;
  /** O `messageId` do corpo da mensagem, não o do SQS (D3.7). */
  messageId: string;
  /** Hash do conteúdo: o `inboxHash` (D3.8) ou o do envelope no auditor (D20.1). */
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt: Date | undefined;
}

/**
 * Registro da inbox (§6.5, D3.7, D3.8, D24): a chave `(consumerName,
 * messageId)`, o hash do conteúdo e quando foi processada. A garantia de
 * "uma vez" é do banco (PK + `ON CONFLICT DO NOTHING` na transação do
 * efeito, D19.4); a classe encapsula o estado e a transição.
 */
export class InboxMessage {
  private constructor(
    public readonly consumerName: string,
    public readonly messageId: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(props.consumerName, props.messageId, props.payloadHash, props.receivedAt);
  }

  /** Reconstrói o estado persistido, sem revalidar (§6.0). */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.consumerName,
      state.messageId,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidInboxTransitionError(`mensagem ${this.messageId} já processada`);
    }
    this._processedAt = at;
  }

  /** Mesmo `messageId` com o mesmo conteúdo é duplicata; com outro, conflito (D3.8). */
  hasSameContentAs(other: InboxMessage): boolean {
    return this.payloadHash === other.payloadHash;
  }
}
