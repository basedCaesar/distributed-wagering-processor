import { Module } from "@nestjs/common";
import { ConsumerModule } from "../modules/wagering/infra/messaging/consumer.module";
import { WAGERING_ENTITIES } from "../modules/wagering/infra/persistence";
import { AppConfigModule } from "../shared/config/config.module";
import { LoggerModule } from "../shared/logger/logger.module";
import { ormModule } from "../shared/orm/orm.module";
import { SecretsModule } from "../shared/secrets/secrets.module";

/** Módulo raiz do processo `consumer` (D7.4, D8): sem HTTP. */
@Module({
  imports: [
    AppConfigModule,
    SecretsModule,
    LoggerModule,
    ormModule(WAGERING_ENTITIES),
    ConsumerModule,
  ],
})
export class ConsumerAppModule {}
