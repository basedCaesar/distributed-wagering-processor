import { Module } from "@nestjs/common";
import { EventAuditorModule } from "../modules/wagering/infra/messaging/event-auditor.module";
import { WAGERING_ENTITIES } from "../modules/wagering/infra/persistence";
import { AppConfigModule } from "../shared/config/config.module";
import { LoggerModule } from "../shared/logger/logger.module";
import { MetricsModule } from "../shared/metrics/metrics.module";
import { ormModule } from "../shared/orm/orm.module";
import { SecretsModule } from "../shared/secrets/secrets.module";

/** Módulo raiz do processo `event-auditor` (D7.4, D9.7): sem HTTP; `/metrics` na porta interna (D22.1). */
@Module({
  imports: [
    AppConfigModule,
    SecretsModule,
    LoggerModule,
    MetricsModule,
    ormModule(WAGERING_ENTITIES, "event-auditor"),
    EventAuditorModule,
  ],
})
export class EventAuditorAppModule {}
