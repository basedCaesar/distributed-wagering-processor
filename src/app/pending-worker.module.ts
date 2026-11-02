import { Module } from "@nestjs/common";
import { WAGERING_ENTITIES } from "../modules/wagering/infra/persistence";
import { PendingWorkerModule } from "../modules/wagering/infra/workers/pending-worker.module";
import { AppConfigModule } from "../shared/config/config.module";
import { LoggerModule } from "../shared/logger/logger.module";
import { MetricsModule } from "../shared/metrics/metrics.module";
import { ormModule } from "../shared/orm/orm.module";
import { SecretsModule } from "../shared/secrets/secrets.module";

/** Módulo raiz do processo `pending-worker` (D4.3, D7.4): sem HTTP; `/metrics` na porta interna (D22.1). */
@Module({
  imports: [
    AppConfigModule,
    SecretsModule,
    LoggerModule,
    MetricsModule,
    ormModule(WAGERING_ENTITIES, "pending-worker"),
    PendingWorkerModule,
  ],
})
export class PendingWorkerAppModule {}
