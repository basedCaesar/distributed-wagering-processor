import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

/**
 * Swagger em `/docs` e o JSON em `/docs-json`, abertos como o health
 * (D13.2). Fica fora dos controllers, então o guard não o alcança.
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle("Distributed Wagering Processor")
    .setDescription(
      "Wallets, ledger e transações de aposta. Status HTTP da D5; erros sem transação no formato { error: { code, message, details? } }.",
    )
    .setVersion("1.0")
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("docs", app, document, { jsonDocumentUrl: "docs-json" });
}
