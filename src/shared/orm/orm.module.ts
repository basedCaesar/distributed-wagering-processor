import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnModuleDestroy,
} from "@nestjs/common";
import { type EntitySchema, MikroORM } from "@mikro-orm/postgresql";
import {
  SECRETS_PROVIDER,
  type SecretsProvider,
} from "../secrets/secrets-provider.port";
import { createOrm } from "./create-orm";

class OrmShutdown implements OnModuleDestroy {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onModuleDestroy(): Promise<void> {
    await this.orm.close();
  }
}

@Global()
@Module({})
export class OrmModule {}

/**
 * Uma instância do `MikroORM` por processo, com as credenciais do
 * `SecretsProvider` (D12.3). Cada processo informa as entidades.
 */
export function ormModule(entities: EntitySchema[]): DynamicModule {
  return {
    module: OrmModule,
    providers: [
      {
        provide: MikroORM,
        useFactory: async (secrets: SecretsProvider) =>
          createOrm({
            credentials: await secrets.getDatabaseCredentials(),
            entities,
          }),
        inject: [SECRETS_PROVIDER],
      },
      OrmShutdown,
    ],
    exports: [MikroORM],
  };
}
