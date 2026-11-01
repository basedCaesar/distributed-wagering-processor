import { Module } from "@nestjs/common";
import { WAGERING_ENTITIES } from "../modules/wagering/infra/persistence";
import { PendingWorkerModule } from "../modules/wagering/infra/workers/pending-worker.module";
import { AppConfigModule } from "../shared/config/config.module";
import { LoggerModule } from "../shared/logger/logger.module";
import { ormModule } from "../shared/orm/orm.module";
import { SecretsModule } from "../shared/secrets/secrets.module";

/** Módulo raiz do processo `pending-worker` (D4.3, D7.4): sem HTTP. */
@Module({
  imports: [
    AppConfigModule,
    SecretsModule,
    LoggerModule,
    ormModule(WAGERING_ENTITIES),
    PendingWorkerModule,
  ],
})
export class PendingWorkerAppModule {}
