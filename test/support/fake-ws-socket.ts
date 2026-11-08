import pino, { type Logger } from "pino";
import type { WsSocket } from "../../src/modules/realtime/infra/ws/connection-session";
import type { Identity, ProviderIdentityPort } from "../../src/shared/auth/provider-identity.port";

const OPEN = 1;
const CLOSED = 3;

/**
 * O lado do servidor de um socket do `ws`, para os testes de unidade da
 * `ConnectionSession`: o teste manda frames, controla o `bufferedAmount` e
 * decide se o cliente responde ao `ping`.
 */
export class FakeWsSocket implements WsSocket {
  readyState = OPEN;
  bufferedAmount = 0;
  /** `false`: o cliente não responde ao `ping` (conexão morta). */
  answersPing = true;
  readonly sent: Record<string, unknown>[] = [];
  closedWith: { code: number; reason: string } | undefined;
  terminated = false;
  pings = 0;
  private onMessage: ((data: unknown, isBinary: boolean) => void) | undefined;
  private onPong: (() => void) | undefined;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code: number, reason = ""): void {
    this.closedWith = { code, reason };
    this.readyState = CLOSED;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = CLOSED;
  }

  ping(): void {
    this.pings++;
    if (this.answersPing) queueMicrotask(() => this.onPong?.());
  }

  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): void;
  on(event: "pong", listener: () => void): void;
  on(event: "message" | "pong", listener: ((data: unknown, isBinary: boolean) => void) | (() => void)): void {
    if (event === "message") this.onMessage = listener as (data: unknown, isBinary: boolean) => void;
    else this.onPong = listener as () => void;
  }

  /** Um frame de texto do cliente (o `ws` entrega um `Buffer`). */
  receive(frame: unknown): void {
    this.onMessage?.(Buffer.from(typeof frame === "string" ? frame : JSON.stringify(frame)), false);
  }
}

/** Um JWT só no formato (a assinatura não é conferida pelo `decodeJwt` da sessão). */
export function unsignedJwt(expSeconds: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", kid: "test-key" })}.${part({ exp: expSeconds, sub: "service-account-test" })}.assinatura`;
}

/** Identidade que aceita qualquer token, ou que falha com o erro dado. */
export function fakeIdentities(outcome: Identity | Error): ProviderIdentityPort {
  return {
    authenticate: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

export const OPERATOR: Identity = { subject: "service-account-test", roles: new Set(["operator"]) };

/** Logger pino de verdade, com as linhas guardadas para o teste conferir (D11.1). */
export function capturedLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(line) });
  return { logger, lines };
}
