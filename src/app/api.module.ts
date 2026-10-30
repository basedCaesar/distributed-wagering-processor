import { Module } from "@nestjs/common";
import { AppConfigModule } from "../shared/config/config.module";
import { HealthModule } from "../shared/health/health.module";
import { SecretsModule } from "../shared/secrets/secrets.module";

@Module({
  imports: [AppConfigModule, SecretsModule, HealthModule],
})
export class ApiModule {}
