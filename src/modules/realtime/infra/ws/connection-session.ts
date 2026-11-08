import { decodeJwt } from "jose";
import type { Logger } from "pino";
import { ValidationError } from "../../../../shared/errors/app-errors";
import { classifyError } from "../../../../shared/errors/classify-error";
import type { Identity, ProviderIdentityPort } from "../../../../shared/auth/provider-identity.port";
import type { RealtimeConnection, RealtimeHub } from "../../application/realtime-hub";
import { CloseCode } from "../../domain/close-codes";
import { type RealtimeEvent, toClientMessage, type Viewer } from "../../domain/realtime-event";
import { isAuthAttempt, parseClientMessage } from "./client-message";

/** O que a sessão usa do socket do `ws` (sem `@types/ws`). */
export interface WsSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): void;
  on(event: "pong", listener: () => void): void;
}

/** Cliente lento (D28.2): mais que isso esperando envio → `1013`. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
/** O maior atraso que o `setTimeout` aceita (~24,8 dias). */
const MAX_TIMER_MS = 2_147_483_647;
const OPEN = 1;

export interface SessionDeps {
  hub: RealtimeHub;
  identities: ProviderIdentityPort;
  logger: Logger;
  authTimeoutMs: number;
  pingIntervalMs: number;
  /** Chamado uma vez, quando a sessão termina (fechamento pelo cliente ou pelo servidor). */
  onEnd: (session: ConnectionSession) => void;
}

type State = "awaiting_auth" | "authenticated" | "closed";

/**
 * Uma conexão do protocolo da D28.2: `auth` no 1º frame (prazo, códigos de
 * fechamento, expiração do token), depois `follow`/`unfollow`. Os frames
 * são tratados em ordem (um `follow` logo atrás do `auth` espera a
 * validação). Toda resposta sai pelo `send`, no formato `{type}` (D28.10).
 */
export class ConnectionSession implements RealtimeConnection {
  private state: State = "awaiting_auth";
  private identity: Identity | undefined;
  private queue: Promise<void> = Promise.resolve();
  private alive = true;
  private readonly authTimer: ReturnType<typeof setTimeout>;
  private readonly pingTimer: ReturnType<typeof setInterval>;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly socket: WsSocket,
    private readonly deps: SessionDeps,
  ) {
    this.authTimer = setTimeout(() => this.close(CloseCode.AuthTimeout, "auth timeout"), deps.authTimeoutMs);
    this.pingTimer = setInterval(() => this.heartbeat(), deps.pingIntervalMs);
    socket.on("pong", () => {
      this.alive = true;
    });
    socket.on("message", (data, isBinary) => {
      const text = isBinary ? undefined : String(data);
      this.queue = this.queue.then(() => this.onFrame(text));
    });
  }

  get viewer(): Viewer {
    if (this.identity === undefined) throw new Error("sessão sem identidade");
    return this.identity;
  }

  /** Entrega do hub (D28.3 já aplicada lá). Cliente lento → `1013`. */
  deliver(event: RealtimeEvent): void {
    if (this.state !== "authenticated" || this.socket.readyState !== OPEN) return;
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.close(CloseCode.TryAgainLater, "slow consumer");
      return;
    }
    this.socket.send(JSON.stringify(toClientMessage(event)));
  }

  /** Fecha pelo servidor, com o código do protocolo. */
  close(code: number, reason: string): void {
    if (this.state === "closed") return;
    this.end();
    if (code !== CloseCode.GoingAway) this.deps.logger.info({ closeCode: code }, "conexão do realtime fechada pelo servidor");
    this.socket.close(code, reason);
  }

  /** O socket fechou (pelo cliente ou depois do `close`). */
  end(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    clearTimeout(this.authTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.expiryTimer);
    this.deps.hub.remove(this);
    this.deps.onEnd(this);
  }

  private async onFrame(text: string | undefined): Promise<void> {
    if (this.state === "closed") return;
    try {
      if (this.state === "awaiting_auth") await this.beforeAuth(text);
      else this.afterAuth(text);
    } catch (error) {
      const { category, code } = classifyError(error);
      this.deps.logger.error({ category, code }, "erro inesperado numa conexão do realtime");
      this.close(CloseCode.InternalError, "internal error");
    }
  }

  private async beforeAuth(text: string | undefined): Promise<void> {
    if (text === undefined) return this.close(CloseCode.ProtocolViolation, "binary frame");
    let token: string;
    try {
      const message = parseClientMessage(text);
      if (message.type !== "auth") return this.close(CloseCode.ProtocolViolation, "auth first");
      token = message.token;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return isAuthAttempt(text)
        ? this.close(CloseCode.Unauthenticated, "unauthenticated")
        : this.close(CloseCode.ProtocolViolation, "invalid frame");
    }

    let identity: Identity;
    try {
      identity = await this.deps.identities.authenticate(token);
    } catch (error) {
      const { category } = classifyError(error);
      if (category === "unauthenticated") return this.close(CloseCode.Unauthenticated, "unauthenticated");
      if (category === "transient") return this.close(CloseCode.AuthUnavailable, "auth unavailable");
      throw error;
    }
    if (this.state === "closed") return;
    this.identity = identity;
    this.state = "authenticated";
    clearTimeout(this.authTimer);
    this.scheduleExpiry(token);
    this.send({ type: "authenticated", roles: [...identity.roles].sort() });
  }

  private afterAuth(text: string | undefined): void {
    this.send(this.reply(text));
  }

  /** A resposta a um frame depois do `auth`: frame inválido não fecha (D28.2). */
  private reply(text: string | undefined): object {
    const invalid = { type: "error", code: "VALIDATION_ERROR" };
    if (text === undefined) return invalid;
    let message: ReturnType<typeof parseClientMessage>;
    try {
      message = parseClientMessage(text);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return invalid;
    }
    switch (message.type) {
      case "auth":
        return invalid;
      case "follow":
        return this.deps.hub.follow(this, message.walletId) === "followed"
          ? { type: "followed", walletId: message.walletId }
          : { type: "error", code: "FOLLOW_LIMIT", walletId: message.walletId };
      case "unfollow":
        this.deps.hub.unfollow(this, message.walletId);
        return { type: "unfollowed", walletId: message.walletId };
    }
  }

  /** O token já foi validado: o `exp` dele marca o fim da conexão (D28.2). */
  private scheduleExpiry(token: string): void {
    const { exp } = decodeJwt(token);
    if (exp === undefined) return;
    const delay = Math.min(Math.max(exp * 1000 - Date.now(), 0), MAX_TIMER_MS);
    this.expiryTimer = setTimeout(() => this.close(CloseCode.Unauthenticated, "token expired"), delay);
  }

  /** Sem `pong` desde o último `ping` → a conexão morreu (D28.2). */
  private heartbeat(): void {
    if (this.state === "closed") return;
    if (!this.alive) {
      this.end();
      this.socket.terminate();
      return;
    }
    this.alive = false;
    this.socket.ping();
  }

  private send(message: object): void {
    if (this.socket.readyState === OPEN) this.socket.send(JSON.stringify(message));
  }
}
