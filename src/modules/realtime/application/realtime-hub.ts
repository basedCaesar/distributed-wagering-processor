import { canSee, type RealtimeEvent, type Viewer } from "../domain/realtime-event";

/** Uma conexão autenticada, vista pelo hub: quem é e como entregar. */
export interface RealtimeConnection {
  readonly viewer: Viewer;
  /** Põe o evento no buffer do socket. Pode lançar se o socket fechou. */
  deliver(event: RealtimeEvent): void;
}

export type FollowResult = "followed" | "limit";

/**
 * As wallets que cada conexão segue, nesta instância (D28.2, D28.3). Só
 * memória local: a garantia é o GET da wallet, não o hub (D28.8).
 */
export class RealtimeHub {
  private readonly byWallet = new Map<string, Set<RealtimeConnection>>();
  private readonly byConnection = new Map<RealtimeConnection, Set<string>>();

  constructor(
    private readonly options: {
      maxFollowsPerConnection: number;
      /** Uma entrega que falhou (a infra classifica e loga, D11.1). */
      onDeliveryFailure?: (error: unknown) => void;
    },
  ) {}

  /** Seguir de novo a mesma wallet não conta duas vezes. */
  follow(connection: RealtimeConnection, walletId: string): FollowResult {
    const followed = this.byConnection.get(connection) ?? new Set<string>();
    if (followed.has(walletId)) return "followed";
    if (followed.size >= this.options.maxFollowsPerConnection) return "limit";
    followed.add(walletId);
    this.byConnection.set(connection, followed);
    const followers = this.byWallet.get(walletId) ?? new Set<RealtimeConnection>();
    followers.add(connection);
    this.byWallet.set(walletId, followers);
    return "followed";
  }

  unfollow(connection: RealtimeConnection, walletId: string): void {
    this.byConnection.get(connection)?.delete(walletId);
    const followers = this.byWallet.get(walletId);
    if (!followers) return;
    followers.delete(connection);
    if (followers.size === 0) this.byWallet.delete(walletId);
  }

  remove(connection: RealtimeConnection): void {
    for (const walletId of this.byConnection.get(connection) ?? []) this.unfollow(connection, walletId);
    this.byConnection.delete(connection);
  }

  /**
   * Entrega o evento a quem segue a wallet e pode vê-lo. Uma conexão que
   * falha (socket fechando) não impede as outras; ela sai pelo `remove`
   * do fechamento. Devolve quantas receberam.
   */
  dispatch(event: RealtimeEvent): number {
    let delivered = 0;
    for (const connection of this.byWallet.get(event.walletId) ?? []) {
      if (!canSee(connection.viewer, event)) continue;
      try {
        connection.deliver(event);
        delivered++;
      } catch (error) {
        // Socket fechando: a entrega é notificação (D28.8) e o fechamento tira a conexão do hub.
        this.options.onDeliveryFailure?.(error);
      }
    }
    return delivered;
  }

  followerCount(walletId: string): number {
    return this.byWallet.get(walletId)?.size ?? 0;
  }
}
