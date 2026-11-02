import {
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { Logger } from "pino";
import { APP_CONFIG, type AppConfig } from "../config/config.module";
import { LOGGER } from "../logger/logger.module";
import { metricsRegistry } from "./metrics";
import { MetricsServer } from "./metrics-server";

/** Sobe o `/metrics` com a aplicação e o fecha no shutdown (D22.1). */
@Injectable()
export class MetricsLifecycle implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(
    @Inject(MetricsServer) private readonly server: MetricsServer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.server.start(this.config.metricsPort);
  }

  async onModuleDestroy(): Promise<void> {
    await this.server.stop();
  }
}

/** Importado pelo módulo raiz de cada um dos 5 processos (D7.4, D22.1). */
@Module({
  providers: [
    {
      provide: MetricsServer,
      useFactory: (logger: Logger) => new MetricsServer(metricsRegistry, logger),
      inject: [LOGGER],
    },
    MetricsLifecycle,
  ],
  exports: [MetricsServer],
})
export class MetricsModule {}
