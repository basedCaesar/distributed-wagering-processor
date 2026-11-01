import type { INestApplication } from "@nestjs/common";
import { setupSwagger } from "../shared/http/swagger";

/**
 * O que o `main-api` e os testes aplicam à aplicação depois de criada.
 * Guard, filtro e middleware vêm do `ApiModule`.
 */
export function configureApiApp(app: INestApplication): void {
  setupSwagger(app);
}
