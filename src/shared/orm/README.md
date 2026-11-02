# shared/orm

Base do MikroORM (D7.1), sem nada específico de um contexto.

- `create-orm.ts`: `createOrm({ credentials, entities, applicationName? })`. Conecta com as credenciais que recebe (a app usa o `SecretsProvider`; as migrations usam o `MigrationSecretsProvider`, D7.3). Sem `version: true` em lugar nenhum (D7.2).
- `db-session.ts`: `lock_timeout` 2 s e `statement_timeout` 5 s (também exportados em ms, para as contas da config, D21.6) e o `application_name` (D21.1), enviados no startup de cada conexão do pool (D5).
- `orm.module.ts`: `ormModule(entities, nomeDoProcesso)`, um ORM por processo. O `application_name` é o `DB_APPLICATION_NAME` ou o nome do processo. O ORM fecha no `onApplicationShutdown`, a **última** etapa do shutdown do Nest: depois de os laços pararem e de a api drenar as requisições (D8.6, D21.2); loga "conexões do banco fechadas".
- `decimal-amount.type.ts`: `numeric(20,2)` ↔ string. `number` em qualquer direção lança `InvalidDecimalAmountError` (D2.4). `null` passa (colunas anuláveis).
- `fk-id.ts`: FK como id (string) no record, declarada `m:1` com `mapToPk` só para o flush ordenar os INSERTs.

## Testes

`test/unit/persistence/decimal-amount-type.spec.ts` e `test/integration/persistence/orm-mapping.spec.ts`.
