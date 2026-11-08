import { describe, expect, it } from "bun:test";
import { type RealtimeConnection, RealtimeHub } from "../../../src/modules/realtime/application/realtime-hub";
import type { RealtimeEvent } from "../../../src/modules/realtime/domain/realtime-event";
import { logDeliveryFailure } from "../../../src/modules/realtime/infra/delivery-failure";
import { ConnectionSession } from "../../../src/modules/realtime/infra/ws/connection-session";
import { UnauthenticatedError } from "../../../src/shared/errors/app-errors";
import type { Identity } from "../../../src/shared/auth/provider-identity.port";
import { capturedLogger, FakeWsSocket, fakeIdentities, OPERATOR, unsignedJwt } from "../../support/fake-ws-socket";
import { waitFor } from "../../support/processes";

const WALLET = "0190f5b8-0000-7000-8000-0000000000d1";
const PLAYER = "player-sensivel-123";
const AMOUNT = "987.65";

/** O que nunca pode aparecer num log (D11.1, D28.11). */
function leaks(lines: readonly string[], secrets: readonly string[]): string[] {
  return lines.filter((line) => secrets.some((secret) => line.toLowerCase().includes(secret.toLowerCase())));
}

/** Uma sessão que recebe o `auth` com `token` e fecha pelo motivo que a identidade e o token dão. */
async function closedSession(identity: Identity | Error, token: string) {
  const socket = new FakeWsSocket();
  const { logger, lines } = capturedLogger();
  const failures: unknown[] = [];
  const session = new ConnectionSession(socket, {
    hub: new RealtimeHub({ maxFollowsPerConnection: 50, onDeliveryFailure: (error) => failures.push(error) }),
    identities: fakeIdentities(identity),
    logger,
    authTimeoutMs: 60_000,
    pingIntervalMs: 60_000,
    onEnd: () => {},
  });
  socket.receive({ type: "auth", token });
  await waitFor(() => socket.closedWith !== undefined, "fechamento", 2000);
  session.end();
  return { code: socket.closedWith?.code, lines };
}

const now = () => Math.floor(Date.now() / 1000);

describe("D11.1 D28.11: os logs do realtime não levam token, valores, saldos nem playerId", () => {
  it("D11.1 D28.2: fechamento 4401 (token recusado) loga só o código", async () => {
    const token = unsignedJwt(now() + 300);
    const { code, lines } = await closedSession(new UnauthenticatedError(`token ${token} recusado`), token);

    expect(code).toBe(4401);
    expect(lines.some((line) => line.includes('"closeCode":4401'))).toBe(true);
    expect(leaks(lines, [token, PLAYER, AMOUNT])).toEqual([]);
  });

  it("D11.1 D28.2: fechamento 4401 (token que venceu durante a conexão) loga só o código", async () => {
    const token = unsignedJwt(now() - 1);
    const { code, lines } = await closedSession(OPERATOR, token);

    expect(code).toBe(4401);
    expect(lines.some((line) => line.includes('"closeCode":4401'))).toBe(true);
    expect(leaks(lines, [token])).toEqual([]);
  });

  it("D11.1 D28.2: fechamento 1011 (bug) loga a categoria e o código, não a mensagem do erro", async () => {
    const token = unsignedJwt(now() + 300);
    const bug = new Error(`bug com o token ${token}, o jogador ${PLAYER} e o saldo ${AMOUNT}`);
    const { code, lines } = await closedSession(bug, token);

    expect(code).toBe(1011);
    expect(lines.some((line) => line.includes('"closeCode":1011'))).toBe(true);
    expect(leaks(lines, [token, PLAYER, AMOUNT])).toEqual([]);
  });

  it("D11.1 D28.7: falha de entrega a um socket loga a categoria e o código, não a mensagem nem o evento", () => {
    const { logger, lines } = capturedLogger();
    const hub = new RealtimeHub({ maxFollowsPerConnection: 50, onDeliveryFailure: logDeliveryFailure(logger) });
    const broken: RealtimeConnection = {
      viewer: OPERATOR,
      deliver: (event) => {
        throw new Error(`socket fechado com ${JSON.stringify(event)} do ${PLAYER}`);
      },
    };
    hub.follow(broken, WALLET);
    const event: RealtimeEvent = {
      eventId: Bun.randomUUIDv7(),
      eventType: "WalletBalanceChanged",
      occurredAt: "2026-11-08T12:00:00.000Z",
      walletId: WALLET,
      walletVersion: 2,
      data: { balanceAfter: { amount: AMOUNT, currency: "BRL" } },
      audience: { kind: "wallet" },
    };

    hub.dispatch(event);

    expect(lines.some((line) => line.includes("entrega a um socket do realtime falhou"))).toBe(true);
    expect(leaks(lines, [PLAYER, AMOUNT, "socket fechado com"])).toEqual([]);
  });
});
