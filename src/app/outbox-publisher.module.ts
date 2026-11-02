import { Module } from "@nestjs/common";
import { OutboxPublisherModule } from "../modules/wagering/infra/outbox/outbox-publisher.module";
import { WAGERING_ENTITIES } from "../modules/wagering/infra/persistence";
import { AppConfigModule } from "../shared/config/config.module";
import { LoggerModule } from "../shared/logger/logger.module";
import { MetricsModule } from "../shared/metrics/metrics.module";
import { ormModule } from "../shared/orm/orm.module";
import { SecretsModule } from "../shared/secrets/secrets.module";

/** Módulo raiz do processo `outbox-publisher` (D7.4, D9.6): sem HTTP; `/metrics` na porta interna (D22.1). */
@Module({
  imports: [
    AppConfigModule,
    SecretsModule,
    LoggerModule,
    MetricsModule,
    ormModule(WAGERING_ENTITIES, "outbox-publisher"),
    OutboxPublisherModule,
  ],
})
export class OutboxPublisherAppModule {}
