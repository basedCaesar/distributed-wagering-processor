import { Global, Module } from "@nestjs/common";
import { loadConfig } from "./config";
import type { AppConfig } from "./config.schema";

export const APP_CONFIG = Symbol("APP_CONFIG");

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useValue: loadConfig() }],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}

export type { AppConfig };
