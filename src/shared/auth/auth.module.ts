import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AUTH_CONFIG, type AuthConfig, loadAuthConfig } from "./auth.config";
import { AuthGuard } from "./auth.guard";
import { JoseProviderIdentity } from "./jose-provider-identity";
import { PROVIDER_IDENTITY } from "./provider-identity.port";

@Module({
  providers: [
    { provide: AUTH_CONFIG, useFactory: () => loadAuthConfig() },
    {
      provide: PROVIDER_IDENTITY,
      useFactory: (config: AuthConfig) => new JoseProviderIdentity(config),
      inject: [AUTH_CONFIG],
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}
