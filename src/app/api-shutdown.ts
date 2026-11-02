import type { Server } from "node:http";
import { type BeforeApplicationShutdown, Inject, Injectable } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { APP_CONFIG, type AppConfig } from "../shared/config/config.module";
import { HealthService } from "../shared/health/health.service";
import { logger } from "../shared/logger/logger";

/**
 * Shutdown da api (D8.6, D21.2), no `SIGTERM` (`enableShutdownHooks`) ou
 * no `app.close()`:
 * 1. a readiness fica falsa;
 * 2. o servidor para de aceitar conexões e fecha as ociosas (keep-alive);
 * 3. as requisições em andamento terminam, até o prazo da requisição
 *    (10 s, D5); depois dele, as conexões que sobraram são fechadas.
 * O ORM só fecha depois, no `onApplicationShutdown` (`OrmShutdown`).
 */
@Injectable()
export class ApiShutdown implements BeforeApplicationShutdown {
  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(HealthService) private readonly health: HealthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async beforeApplicationShutdown(): Promise<void> {
    this.health.markShuttingDown();
    const server = this.adapterHost.httpAdapter?.getHttpServer() as Server | undefined;
    if (!server?.listening) return;
    const graceMs = this.config.http.requestTimeoutMs;
    const drained = await new Promise<boolean>((resolve) => {
      // Uma conexão keep-alive fica ociosa quando a requisição dela termina,
      // depois do `close()`: fechadas as ociosas a cada 100 ms, o servidor
      // fecha assim que a última requisição termina.
      const idle = setInterval(() => server.closeIdleConnections(), 100);
      const timer = setTimeout(() => {
        clearInterval(idle);
        server.closeAllConnections();
        resolve(false);
      }, graceMs);
      server.close(() => {
        clearInterval(idle);
        clearTimeout(timer);
        resolve(true);
      });
      server.closeIdleConnections();
    });
    logger.info({ drained, graceMs }, drained ? "api drenada" : "api fechada no prazo, com conexões abertas");
  }
}
