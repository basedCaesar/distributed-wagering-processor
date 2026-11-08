import { waitFor } from "./processes";

/** O que o servidor do realtime manda (D28.2, D28.4). */
export interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

export interface EventMessage extends ServerMessage {
  type: "event";
  eventId: string;
  eventType: string;
  occurredAt: string;
  walletId: string;
  walletVersion: number | null;
  data: Record<string, unknown>;
}

export interface TestWsClient {
  /** Mensagens recebidas, na ordem de chegada. */
  messages: ServerMessage[];
  /** Só os eventos (`type: "event"`). */
  events(): EventMessage[];
  send(frame: unknown): void;
  sendRaw(frame: string): void;
  /** Espera uma mensagem que satisfaça `predicate` (estado observável, sem `sleep`). */
  waitFor(predicate: (message: ServerMessage) => boolean, what: string, timeoutMs?: number): Promise<ServerMessage>;
  /** Resolve no fechamento, com o código e o motivo. */
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

/** Abre um `WebSocket` real (o cliente do Bun) e espera o `open`. */
export async function openClient(url: string): Promise<TestWsClient> {
  const socket = new WebSocket(url);
  const messages: ServerMessage[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as ServerMessage);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true });
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`falha ao abrir ${url}`)), { once: true });
  });

  return {
    messages,
    events: () => messages.filter((message): message is EventMessage => message.type === "event"),
    send: (frame) => socket.send(JSON.stringify(frame)),
    sendRaw: (frame) => socket.send(frame),
    async waitFor(predicate, what, timeoutMs = 20_000) {
      await waitFor(() => messages.some(predicate), what, timeoutMs);
      return messages.find(predicate) as ServerMessage;
    },
    closed,
    close: () => socket.close(),
  };
}

/** Cliente autenticado (`auth` → `authenticated`) que segue as wallets dadas (cada `follow` → `followed`). */
export async function followingClient(url: string, token: string, walletIds: readonly string[]): Promise<TestWsClient> {
  const client = await openClient(url);
  client.send({ type: "auth", token });
  await client.waitFor((message) => message.type === "authenticated", "authenticated");
  for (const walletId of walletIds) {
    client.send({ type: "follow", walletId });
    await client.waitFor((message) => message.type === "followed" && message.walletId === walletId, `followed ${walletId}`);
  }
  return client;
}

/** Os `walletVersion` dos `WalletBalanceChanged` recebidos, na ordem de chegada. */
export function balanceVersions(client: Pick<TestWsClient, "events">, walletId: string): number[] {
  return client
    .events()
    .filter((event) => event.eventType === "WalletBalanceChanged" && event.walletId === walletId)
    .map((event) => event.walletVersion as number);
}
