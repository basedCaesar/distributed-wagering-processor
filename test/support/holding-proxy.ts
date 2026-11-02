import { createServer, connect as netConnect, type Server, type Socket } from "node:net";

/**
 * Proxy TCP de teste na frente do LocalStack **real** (nada é simulado: os
 * bytes chegam ao LocalStack como vieram). Com `hold()`, ele para de
 * repassar o que o cliente manda; com `release()`, repassa o que segurou e
 * volta ao normal. Serve para deixar um processo com uma chamada em voo
 * (por exemplo, o `Publish` do outbox-publisher com o evento reivindicado)
 * por quanto tempo o teste quiser, sem `sleep` (achado 4 da revisão da S8).
 */
export interface HoldingProxy {
  /** `http://127.0.0.1:<porta>`: o `AWS_ENDPOINT` do processo que passa pelo proxy. */
  url: string;
  hold(): void;
  release(): void;
  close(): Promise<void>;
}

interface Pair {
  client: Socket;
  upstream: Socket;
  held: Buffer[];
}

export async function startHoldingProxy(upstreamUrl: string): Promise<HoldingProxy> {
  const target = new URL(upstreamUrl);
  const upstreamPort = Number(target.port);
  let holding = false;
  const pairs = new Set<Pair>();

  const server: Server = createServer((client) => {
    const upstream = netConnect(upstreamPort, target.hostname);
    const pair: Pair = { client, upstream, held: [] };
    pairs.add(pair);
    client.on("data", (chunk: Buffer) => {
      if (holding) pair.held.push(chunk);
      else upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => client.write(chunk));
    const closeBoth = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on("close", closeBoth);
    upstream.on("close", closeBoth);
    // Erro de socket (o processo do outro lado morto à força): fecha o par, é o que o teste provoca.
    client.on("error", closeBoth);
    upstream.on("error", closeBoth);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("proxy sem porta");

  return {
    url: `http://127.0.0.1:${address.port}`,
    hold() {
      holding = true;
    },
    release() {
      holding = false;
      for (const pair of pairs) {
        for (const chunk of pair.held.splice(0)) pair.upstream.write(chunk);
      }
    },
    async close() {
      for (const pair of pairs) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
