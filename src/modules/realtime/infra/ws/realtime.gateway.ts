import { Inject } from "@nestjs/common";
import { type OnGatewayConnection, type OnGatewayDisconnect, WebSocketGateway } from "@nestjs/websockets";
import type { Logger } from "pino";
import { PROVIDER_IDENTITY, type ProviderIdentityPort } from "../../../../shared/auth/provider-identity.port";
import { LOGGER } from "../../../../shared/logger/logger.module";
import { realtimeConnections } from "../../../../shared/metrics/metrics";
import { RealtimeHub } from "../../application/realtime-hub";
import { CloseCode } from "../../domain/close-codes";
import { REALTIME_CONFIG, type RealtimeConfig } from "../realtime-config";
import { ConnectionSession, type WsSocket } from "./connection-session";

/** Frame acima disso → `1009` pelo próprio `ws` (D28.2). */
const MAX_FRAME_BYTES = 4096;

/**
 * `ws://<host>/realtime` (D28.2, D28.10), no servidor HTTP do Nest, pelo
 * `WsAdapter`. O gateway não usa `@SubscribeMessage`: cada conexão vira uma
 * `ConnectionSession`, que trata os frames e responde pelo `send`.
 */
@WebSocketGateway({ path: "/realtime", maxPayload: MAX_FRAME_BYTES })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly sessions = new Map<WsSocket, ConnectionSession>();

  constructor(
    @Inject(RealtimeHub) private readonly hub: RealtimeHub,
    @Inject(PROVIDER_IDENTITY) private readonly identities: ProviderIdentityPort,
    @Inject(REALTIME_CONFIG) private readonly config: RealtimeConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  handleConnection(socket: WsSocket): void {
    const session = new ConnectionSession(socket, {
      hub: this.hub,
      identities: this.identities,
      logger: this.logger,
      authTimeoutMs: this.config.authTimeoutMs,
      pingIntervalMs: this.config.pingIntervalMs,
      onEnd: () => {
        if (this.sessions.delete(socket)) realtimeConnections.dec();
      },
    });
    this.sessions.set(socket, session);
    realtimeConnections.inc();
  }

  handleDisconnect(socket: WsSocket): void {
    this.sessions.get(socket)?.end();
  }

  /** SIGTERM (D28.5): todos com `1001`, para reconectarem em outra instância. */
  closeAll(): number {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) session.close(CloseCode.GoingAway, "going away");
    return sessions.length;
  }
}
