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
import { LoggerModule } from "../shared/logger/logger.module";
import { ormModule } from "../shared/orm/orm.module";
import { SecretsModule } from "../shared/secrets/secrets.module";
import { ApiShutdown } from "./api-shutdown";

@Module({
  imports: [
    AppConfigModule,
    SecretsModule,
    LoggerModule,
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
    consumer.apply(RequestDeadlineMiddleware, CorrelationMiddleware).forRoutes("*path");
  }
}
