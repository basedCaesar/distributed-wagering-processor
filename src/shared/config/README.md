# shared/config

Configuração tipada, validada com `zod` na subida do processo. Config inválida derruba o processo na hora com `ConfigValidationError`, em vez de falhar no meio de uma requisição.

- `config.schema.ts`: o schema (`AppConfig`).
- `config.ts`: `loadConfig(env)` lê as variáveis de ambiente e valida.
- `config.module.ts`: módulo NestJS global que expõe o `AppConfig` pelo token `APP_CONFIG`.

## Regras

- `CURRENCIES`: lista de moedas aceitas, padrão `BRL,USD`, só códigos de 3 letras (D2.5). A checagem "moeda está na lista" é feita no contrato de entrada, não no domínio (D14.7).
- Credenciais do banco **não** ficam aqui: vêm do `SecretsProvider` (`../secrets`, D12.3).
- Timeouts de health em `HEALTH_CHECK_TIMEOUT_MS` (padrão 1 s, D11.3).

Variáveis: ver `.env.example` (dev) e `.env.test` (testes).

## Testes

`test/unit/config.spec.ts`.
