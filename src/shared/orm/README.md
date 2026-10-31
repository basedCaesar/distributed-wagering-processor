# shared/orm

Base do MikroORM (D7.1), sem nada específico de um contexto.

- `create-orm.ts`: `createOrm({ credentials, entities })`. Conecta com as credenciais que recebe (a app usa o `SecretsProvider`; as migrations usam o `MigrationSecretsProvider`, D7.3). Sem `version: true` em lugar nenhum (D7.2).
- `db-session.ts`: `lock_timeout` 2 s e `statement_timeout` 5 s, enviados no startup de cada conexão do pool (D5).
- `decimal-amount.type.ts`: `numeric(20,2)` ↔ string. `number` em qualquer direção lança `InvalidDecimalAmountError` (D2.4). `null` passa (colunas anuláveis).
- `fk-id.ts`: FK como id (string) no record, declarada `m:1` com `mapToPk` só para o flush ordenar os INSERTs.

O módulo NestJS que injeta o ORM entra na S3, com o primeiro use case.

## Testes

`test/unit/persistence/decimal-amount-type.spec.ts` e `test/integration/persistence/orm-mapping.spec.ts`.
