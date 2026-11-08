import { describe, expect, it } from "bun:test";
import { RealtimeHub } from "../../../src/modules/realtime/application/realtime-hub";
import type { RealtimeEvent } from "../../../src/modules/realtime/domain/realtime-event";
import { ConnectionSession } from "../../../src/modules/realtime/infra/ws/connection-session";
import type { Identity } from "../../../src/shared/auth/provider-identity.port";
import { capturedLogger, FakeWsSocket, fakeIdentities, OPERATOR, unsignedJwt } from "../../support/fake-ws-socket";
import { waitFor } from "../../support/processes";

const WALLET = "0190f5b8-0000-7000-8000-0000000000c1";
/** O limite da D28.2 para o buffer de envio. */
const ONE_MB = 1024 * 1024;

function balanceEvent(): RealtimeEvent {
  return {
    eventId: Bun.randomUUIDv7(),
    eventType: "WalletBalanceChanged",
    occurredAt: "2026-11-08T12:00:00.000Z",
    walletId: WALLET,
    walletVersion: 2,
    data: {},
    audience: { kind: "wallet" },
  };
}

function setup(options: { identity?: Identity | Error; pingIntervalMs?: number } = {}) {
  const socket = new FakeWsSocket();
  const failures: unknown[] = [];
  const hub = new RealtimeHub({ maxFollowsPerConnection: 50, onDeliveryFailure: (error) => failures.push(error) });
  const { logger, lines } = capturedLogger();
  let ended = 0;
  const session = new ConnectionSession(socket, {
    hub,
    identities: fakeIdentities(options.identity ?? OPERATOR),
    logger,
    authTimeoutMs: 60_000,
    pingIntervalMs: options.pingIntervalMs ?? 60_000,
    onEnd: () => ended++,
  });
  return { socket, hub, session, lines, failures, ended: () => ended };
}

/** Autentica e segue a wallet, esperando as respostas (estado observável). */
async function authenticateAndFollow(socket: FakeWsSocket): Promise<void> {
  socket.receive({ type: "auth", token: unsignedJwt(Math.floor(Date.now() / 1000) + 300) });
  await waitFor(() => socket.sent.some((message) => message.type === "authenticated"), "authenticated", 2000);
  socket.receive({ type: "follow", walletId: WALLET });
  await waitFor(() => socket.sent.some((message) => message.type === "followed"), "followed", 2000);
}

describe("D28.2: proteções da conexão", () => {
  it("D28.2: cliente lento (mais de 1 MB esperando envio) → fecha com 1013, sem enviar o evento", async () => {
    const { socket, hub, session } = setup();
    await authenticateAndFollow(socket);
    const before = socket.sent.length;
    socket.bufferedAmount = ONE_MB + 1;

    hub.dispatch(balanceEvent());

    expect(socket.closedWith?.code).toBe(1013);
    expect(socket.sent.length).toBe(before);
    expect(hub.followerCount(WALLET)).toBe(0);
    session.end();
  });

  it("D28.2: no limite (1 MB esperando) o evento ainda sai", async () => {
    const { socket, hub, session } = setup();
    await authenticateAndFollow(socket);
    socket.bufferedAmount = ONE_MB;

    hub.dispatch(balanceEvent());

    expect(socket.closedWith).toBeUndefined();
    expect(socket.sent.at(-1)?.type).toBe("event");
    session.end();
  });

  it("D28.2: sem pong até o ping seguinte → a conexão é encerrada (terminate) e sai do hub", async () => {
    const { socket, hub, ended } = setup({ pingIntervalMs: 10 });
    await authenticateAndFollow(socket);
    socket.answersPing = false;

    await waitFor(() => socket.terminated, "terminate da conexão sem pong", 2000);

    expect(hub.followerCount(WALLET)).toBe(0);
    expect(ended()).toBe(1);
  });

  it("D28.2: com pong a cada ping, a conexão continua aberta", async () => {
    const { socket, session } = setup({ pingIntervalMs: 10 });
    await authenticateAndFollow(socket);

    await waitFor(() => socket.pings >= 5, "5 pings respondidos", 2000);

    expect(socket.terminated).toBe(false);
    expect(socket.closedWith).toBeUndefined();
    session.end();
  });

  it("D28.2: erro inesperado do servidor (bug) → fecha com 1011, logado pelo classifyError", async () => {
    const { socket, lines, ended } = setup({ identity: new Error("bug inesperado na validação") });

    socket.receive({ type: "auth", token: unsignedJwt(Math.floor(Date.now() / 1000) + 300) });
    await waitFor(() => socket.closedWith !== undefined, "fechamento", 2000);

    expect(socket.closedWith?.code).toBe(1011);
    expect(ended()).toBe(1);
    expect(lines.some((line) => line.includes("erro inesperado numa conexão do realtime"))).toBe(true);
  });
});
