import type { INestApplication } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";

/**
 * `WsAdapter` do `@nestjs/platform-ws` (D28.10). O parser devolve nada: o
 * gateway trata cada frame na `ConnectionSession` (D28.2), sem o
 * despacho por `@SubscribeMessage`. Usado pelo entrypoint e pelos testes.
 */
export function configureRealtimeApp(app: INestApplication): void {
  app.useWebSocketAdapter(new WsAdapter(app, { messageParser: () => undefined }));
}
