import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { WAGERING_ENTITIES } from "../modules/wagering/infra/persistence";
import { WageringModule } from "../modules/wagering/infra/wagering.module";
import { AuthModule } from "../shared/auth/auth.module";
import { AppConfigModule } from "../shared/config/config.module";
import { HttpErrorFilter } from "../shared/errors/http-exception.filter";
import { HealthModule } from "../shared/health/health.module";
import { CorrelationMiddleware } from "../shared/http/correlation.middleware";
import { RequestDeadlineInterceptor, RequestDeadlineMiddleware } from "../shared/http/request-deadline";
import { AccessLogMiddleware } from "../shared/http/access-log.middleware";
import { LoggerModule } from "../shared/logger/logger.module";
import { MetricsModule } from "../shared/metrics/metrics.module";
import { ormModule } from "../shared/orm/orm.module";
import { SecretsModule } from "../shared/secrets/secrets.module";
import { ApiShutdown } from "./api-shutdown";

/** `/metrics` fica na porta interna (D22.1), nunca na pública. */
@Module({
  imports: [
    AppConfigModule,
    SecretsModule,
    LoggerModule,
    MetricsModule,
    ormModule(WAGERING_ENTITIES, "api"),
    AuthModule,
    HealthModule,
    WageringModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    // Prazo da requisição (D5, D21.3).
    { provide: APP_INTERCEPTOR, useClass: RequestDeadlineInterceptor },
    ApiShutdown,
  ],
})
export class ApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // A linha de acesso (D22.9 b) depois da correlação: ela lê o contexto da requisição.
    consumer.apply(RequestDeadlineMiddleware, CorrelationMiddleware, AccessLogMiddleware).forRoutes("*path");
  }
}
