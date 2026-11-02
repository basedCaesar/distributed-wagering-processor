# shared/config

Configuração tipada, validada com `zod` na subida do processo. Config inválida derruba o processo na hora com `ConfigValidationError`, em vez de falhar no meio de uma requisição.

- `config.schema.ts`: o schema (`AppConfig`).
- `config.ts`: `loadConfig(env)` lê as variáveis de ambiente e valida.
- `config.module.ts`: módulo NestJS global que expõe o `AppConfig` pelo token `APP_CONFIG`.

## Regras

- `CURRENCIES`: lista de moedas aceitas, padrão `BRL,USD`, só códigos de 3 letras (D2.5). A checagem "moeda está na lista" é feita no contrato de entrada, não no domínio (D14.7).
- Credenciais do banco **não** ficam aqui: vêm do `SecretsProvider` (`../secrets`, D12.3).
- Timeouts de health em `HEALTH_CHECK_TIMEOUT_MS` (padrão 1 s, D11.3).
- `HTTP_REQUEST_TIMEOUT_MS` (padrão 10 000): prazo de cada requisição (D5, D21.3) e, no shutdown, o prazo para as requisições em andamento terminarem (D8.6).
- `DB_APPLICATION_NAME` (opcional, formato da D6.4, até 63 caracteres): o `application_name` das conexões ao Postgres. Sem ele, cada processo usa o próprio nome (`api`, `consumer`…). No Compose, as `api` usam `api-1..3`; nos testes, cada processo separado tem o seu (D21.1).
- Contas validadas juntas na subida (D21.6), com os padrões de antes da S8:

| Variáveis | Padrão | A conta |
|---|---|---|
| `OUTBOX_LEASE_MS`, `OUTBOX_SNS_REQUEST_TIMEOUT_MS` | 30 000, 10 000 | timeout do SNS < lease (D20.5) |
| `PENDING_LEASE_MS`, `PENDING_BATCH_SIZE` | 30 000, 10 | lote × `lock_timeout` (2 s) < lease (D18.2) |
| `CONSUMER_VISIBILITY_TIMEOUT_S`, `CONSUMER_MAX_MESSAGES` | 120, 10 | mensagens × (2 s + 5 s) ≤ visibilidade (D19.6); no máximo 10 por receive |

Os prazos curtos existem para os testes de reinício (R-13-C8) não esperarem 120 s de visibilidade presa; em produção, os padrões.

Variáveis: ver `.env.example` (dev) e `.env.test` (testes).

## Testes

`test/unit/config.spec.ts`.
