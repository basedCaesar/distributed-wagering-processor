import { Module } from "@nestjs/common";
import { EventAuditorModule } from "../modules/wagering/infra/messaging/event-auditor.module";
import { WAGERING_ENTITIES } from "../modules/wagering/infra/persistence";
import { AppConfigModule } from "../shared/config/config.module";
import { LoggerModule } from "../shared/logger/logger.module";
import { ormModule } from "../shared/orm/orm.module";
import { SecretsModule } from "../shared/secrets/secrets.module";

/** Módulo raiz do processo `event-auditor` (D7.4, D9.7): sem HTTP. */
@Module({
  imports: [AppConfigModule, SecretsModule, LoggerModule, ormModule(WAGERING_ENTITIES), EventAuditorModule],
})
export class EventAuditorAppModule {}
