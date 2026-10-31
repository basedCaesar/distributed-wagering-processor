# shared/secrets

Porta `SecretsProvider` para credenciais (D12.3). O núcleo nunca lê a senha do banco direto do ambiente: pede ao provider.

- `secrets-provider.port.ts`: a porta e o token `SECRETS_PROVIDER`; e a porta `MigrationSecretsProvider`, com as credenciais do papel dono, que só as migrations usam (D7.3). Ela é separada para a aplicação nunca receber o dono por injeção.
- `env-secrets-provider.ts`: adaptador que lê `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` e `DB_PASSWORD` (papel da app); e `DB_MIGRATION_USER`/`DB_MIGRATION_PASSWORD` (papel dono), com o mesmo host, porta e banco. Variável ausente → `MissingSecretError`, sem cair no outro papel.
- `secrets.module.ts`: módulo NestJS global que liga a porta ao adaptador.

## Regras

- Nenhum segredo real no repositório: `.env.example` e `.env.test` só têm valores locais.
- O adaptador do Secrets Manager (LocalStack) é um extra; entra como outro adaptador da mesma porta, sem mudar quem a usa (D12.3, "Encaixes").

## Testes

`test/unit/secrets-provider.spec.ts`.
