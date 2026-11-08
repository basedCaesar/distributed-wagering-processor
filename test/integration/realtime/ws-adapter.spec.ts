import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WsAdapter } from "@nestjs/platform-ws";
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";

/** O que o teste usa do `WebSocketServer` do `ws` (sem `@types/ws`). */
interface Server {
  clients: Set<{ close(code: number, reason: string): void; send(data: string): void }>;
}

/**
 * D28 (S15, passo 1): prova que o `WsAdapter` do `@nestjs/platform-ws`
 * funciona no Bun, com o servidor HTTP do Nest (upgrade pelo `node:http`),
 * o protocolo `{"type": …}` por `messageParser`, códigos de fechamento
 * próprios e envio iniciado pelo servidor. Se este teste falhar, o plano B é
 * um adapter sobre o WebSocket nativo do `Bun.serve`.
 */
@WebSocketGateway({ path: "/realtime" })
class ProbeGateway {
  @WebSocketServer() server!: Server;

  /**
   * O valor retornado por um handler sai embrulhado pelo Nest em
   * `{event, data}`: para manter o protocolo `{type}` (D28), o gateway
   * responde pelo próprio socket.
   */
  @SubscribeMessage("echo")
  echo(@MessageBody() body: { value: string }, @ConnectedSocket() client: { send(data: string): void }) {
    client.send(JSON.stringify({ type: "echoed", value: body.value }));
  }

  @SubscribeMessage("reject")
  reject(@MessageBody() _: unknown) {
    for (const client of this.server.clients) client.close(4401, "unauthenticated");
  }

  broadcast(payload: object): void {
    for (const client of this.server.clients) client.send(JSON.stringify(payload));
  }
}

@Module({ providers: [ProbeGateway] })
class ProbeModule {}

let app: INestApplication;
let url: string;

beforeAll(async () => {
  app = await NestFactory.create(ProbeModule, { logger: false });
  app.useWebSocketAdapter(
    new WsAdapter(app, {
      messageParser: (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string };
        return { event: message.type, data: message };
      },
    }),
  );
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  url = `ws://127.0.0.1:${port}/realtime`;
});

afterAll(async () => {
  await app.close();
});

function open(): Promise<globalThis.WebSocket> {
  const socket = new globalThis.WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("falha ao abrir o WebSocket")), { once: true });
  });
}

function nextMessage(socket: globalThis.WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true });
  });
}

function closed(socket: globalThis.WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.addEventListener("close", (event) => resolve(event.code), { once: true });
  });
}

describe("D28: WsAdapter do NestJS no Bun", () => {
  it("D28 V-03: upgrade pelo servidor HTTP do Nest e resposta a uma mensagem {type}", async () => {
    const socket = await open();
    const reply = nextMessage(socket);
    socket.send(JSON.stringify({ type: "echo", value: "olá" }));
    expect(await reply).toEqual({ type: "echoed", value: "olá" });
    socket.close();
  });

  it("D28: o servidor envia sem pedido do cliente (notificação)", async () => {
    const socket = await open();
    const message = nextMessage(socket);
    const gateway = app.get(ProbeGateway);
    gateway.broadcast({ type: "event", eventId: "e1" });
    expect(await message).toEqual({ type: "event", eventId: "e1" });
    socket.close();
  });

  it("D28: código de fechamento próprio (4401) chega ao cliente", async () => {
    const socket = await open();
    const code = closed(socket);
    socket.send(JSON.stringify({ type: "reject" }));
    expect(await code).toBe(4401);
  });

  it("D28: caminho diferente de /realtime não faz upgrade", async () => {
    const socket = new globalThis.WebSocket(url.replace("/realtime", "/outro"));
    const outcome = await new Promise<string>((resolve) => {
      socket.addEventListener("open", () => resolve("open"), { once: true });
      socket.addEventListener("error", () => resolve("error"), { once: true });
      socket.addEventListener("close", () => resolve("close"), { once: true });
    });
    expect(outcome).not.toBe("open");
  });
});
