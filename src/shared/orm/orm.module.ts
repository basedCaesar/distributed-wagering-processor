import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { type EntitySchema, MikroORM } from "@mikro-orm/postgresql";
import { APP_CONFIG, type AppConfig } from "../config/config.module";
import { logger } from "../logger/logger";
import {
  SECRETS_PROVIDER,
  type SecretsProvider,
} from "../secrets/secrets-provider.port";
import { createOrm } from "./create-orm";

/**
 * Fecha o ORM na **última** etapa do shutdown do Nest (D8.6, D21.2):
 * depois dos `onModuleDestroy` (os laços dos workers param) e do fechamento
 * do servidor HTTP (a api drena as requisições em andamento). Fechar antes
 * deixaria uma requisição ou um item em andamento sem banco.
 */
class OrmShutdown implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
    logger.info("conexões do banco fechadas");
  }
}

@Global()
@Module({})
export class OrmModule {}

/**
 * Uma instância do `MikroORM` por processo, com as credenciais do
 * `SecretsProvider` (D12.3). Cada processo informa as entidades e o nome
 * que vai no `application_name` das conexões, salvo `DB_APPLICATION_NAME`
 * (D21.1).
 */
export function ormModule(entities: EntitySchema[], processName: string): DynamicModule {
  return {
    module: OrmModule,
    providers: [
      {
        provide: MikroORM,
        useFactory: async (secrets: SecretsProvider, config: AppConfig) =>
          createOrm({
            credentials: await secrets.getDatabaseCredentials(),
            entities,
            applicationName: config.dbApplicationName ?? processName,
          }),
        inject: [SECRETS_PROVIDER, APP_CONFIG],
      },
      OrmShutdown,
    ],
    exports: [MikroORM],
  };
}
