/** O que o cliente faz com um evento recebido (D28.8). */
export type ViewDecision = "apply" | "skip" | "resync";

export interface ViewedEvent {
  eventId: string;
  eventType: string;
  walletVersion: number | null;
}

/** Os eventos que mudam a versão da wallet; os outros só a citam. */
const WALLET_EVENTS = new Set(["WalletBalanceChanged", "WalletOpened"]);
/** Quantos `eventId` a visão lembra para descartar duplicatas. */
const REMEMBERED_EVENTS = 1000;

/**
 * Contrato do cliente (D28.8): o WebSocket é notificação, a verdade é o
 * `GET /wallets/:id`. A visão parte da `version` do GET; um evento da
 * wallet com a versão seguinte é aplicado, um com versão já contida é
 * descartado, e um furo pede um novo GET (`resync`). Os eventos de
 * transação são aplicados uma vez (pelo `eventId`), salvo os que o
 * snapshot já contém.
 */
export class WalletView {
  private current: number;
  /** A versão do último GET: o que ela contém não é aplicado de novo. */
  private snapshot: number;
  private readonly seen = new Set<string>();

  constructor(version: number) {
    this.current = version;
    this.snapshot = version;
  }

  get version(): number {
    return this.current;
  }

  accept(event: ViewedEvent): ViewDecision {
    if (this.seen.has(event.eventId)) return "skip";
    const decision = this.decide(event);
    if (decision === "apply") this.remember(event.eventId);
    return decision;
  }

  /** Depois de um novo GET (furo ou reconexão). */
  resync(version: number): void {
    this.current = version;
    this.snapshot = version;
  }

  private decide(event: ViewedEvent): ViewDecision {
    const version = event.walletVersion;
    if (!WALLET_EVENTS.has(event.eventType)) {
      return version !== null && version <= this.snapshot ? "skip" : "apply";
    }
    if (version === null || version <= this.current) return "skip";
    if (version > this.current + 1) return "resync";
    this.current = version;
    return "apply";
  }

  private remember(eventId: string): void {
    this.seen.add(eventId);
    if (this.seen.size > REMEMBERED_EVENTS) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
