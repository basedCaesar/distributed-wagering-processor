import type { Server } from "bun";
import type { Logger } from "pino";
import type { Registry } from "prom-client";
import { classifyError } from "../errors/classify-error";

/**
 * `/metrics` numa porta interna própria, sem auth (D11.2, D22.1), em todo
 * processo. Só `GET /metrics`; o resto é `404`. A porta pública da `api`
 * não serve métricas.
 */
export class MetricsServer {
  private server: Server<undefined> | undefined;

  constructor(
    private readonly registry: Registry,
    private readonly logger: Logger,
  ) {}

  /** A porta em que escuta (útil com `METRICS_PORT=0`); `undefined` antes do `start`. */
  get port(): number | undefined {
    return this.server?.port;
  }

  start(port: number): void {
    if (this.server) return;
    this.server = Bun.serve({
      port,
      fetch: async (request) => {
        const { pathname } = new URL(request.url);
        if (request.method !== "GET" || pathname !== "/metrics") {
          return new Response("Not Found", { status: 404 });
        }
        try {
          return new Response(await this.registry.metrics(), {
            headers: { "content-type": this.registry.contentType },
          });
        } catch (error) {
          const { category, code } = classifyError(error);
          this.logger.error({ category, code }, "scrape de /metrics falhou");
          return new Response("scrape falhou", { status: 500 });
        }
      },
    });
    this.logger.info({ metricsPort: this.server.port }, "métricas em /metrics");
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = undefined;
  }
}
