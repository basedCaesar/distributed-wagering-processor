import { Module } from "@nestjs/common";
import { RealtimeModule } from "../modules/realtime/infra/realtime.module";
import { LoggerModule } from "../shared/logger/logger.module";

/**
 * Módulo raiz do processo `realtime` (D28.11): WebSocket em `/realtime`,
 * `/metrics` na porta interna (D22.1). Sem banco, sem a config comum.
 */
@Module({
  imports: [LoggerModule, RealtimeModule],
})
export class RealtimeAppModule {}
