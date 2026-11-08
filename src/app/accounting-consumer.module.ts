import { Module } from "@nestjs/common";
import { AccountingConsumerModule } from "../modules/accounting/infra/accounting-consumer.module";
import { AppConfigModule } from "../shared/config/config.module";
import { LoggerModule } from "../shared/logger/logger.module";
import { MetricsModule } from "../shared/metrics/metrics.module";
import { ormModule } from "../shared/orm/orm.module";
import { SecretsModule } from "../shared/secrets/secrets.module";

/**
 * Módulo raiz do processo `accounting-consumer` (D27.6): sem HTTP;
 * `/metrics` na porta interna (D22.1). Sem entidades do ORM: o accounting
 * grava por SQL direto, com o `accounting_app` (D27.3).
 */
@Module({
  imports: [
    AppConfigModule,
    SecretsModule,
    LoggerModule,
    MetricsModule,
    ormModule([], "accounting-consumer"),
    AccountingConsumerModule,
  ],
})
export class AccountingConsumerAppModule {}
