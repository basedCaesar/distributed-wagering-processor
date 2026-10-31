# distributed-wagering-processor

Processador distribuído de transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`), recebidas por HTTP e por SQS. O foco é correção financeira, concorrência e idempotência.

- Enunciado: [`docs/CHALLENGE.md`](docs/CHALLENGE.md)
- Requisitos, decisões e plano: [`docs/01-requisitos.md`](docs/01-requisitos.md), [`docs/02-decisoes.md`](docs/02-decisoes.md), [`docs/03-plano.md`](docs/03-plano.md)
- Como foi feito com IA: [`AI_WORKFLOW.md`](AI_WORKFLOW.md)

## Requisitos

- [Bun](https://bun.sh) 1.x
- Docker com Docker Compose

## Comandos

```bash
bun install

bun run infra:up          # Compose completo (Postgres, LocalStack, api)
bun run infra:down
bun run infra:test:up     # infraestrutura dos testes (portas separadas)
bun run infra:test:down

bun run migration:up      # aplica as migrations (papel dono)
bun run migration:down    # desfaz todas
bun run migration:verify  # up → down → up no banco de teste

bun run check             # typecheck + lint + unit + migration:verify + integração + concorrência
bun run acceptance        # exemplos do §9 e do §10, literalmente
```

`bun run check` precisa da infraestrutura de teste no ar (`bun run infra:test:up`). No Compose de dev, o serviço `migrate` aplica as migrations antes da `api` subir.

Para rodar a API ou as migrations **fora do Docker** (`bun run migration:up`, `bun run src/entrypoints/main-api.ts`), crie antes o `.env` a partir do exemplo:

```bash
cp .env.example .env              # Linux/Mac
Copy-Item .env.example .env       # Windows (PowerShell)
```

`bun run infra:up` e `bun run check` **não** precisam do `.env`: o Compose define as variáveis de cada serviço e os testes usam o `.env.test`.

> **Quem já tinha os containers de antes da S2 precisa recriá-los.** Os papéis do banco (`wagering_owner`, `wagering_app`) são criados pelo `scripts/postgres-init.sh`, que o Postgres só roda num volume novo:
>
> ```bash
> bun run infra:test:down && bun run infra:test:up    # testes
> docker compose down -v && bun run infra:up          # dev (apaga os dados locais)
> ```

## Infraestrutura

| Serviço | Dev (`docker-compose.yml`) | Testes (`docker-compose.test.yml`) |
|---|---|---|
| Postgres 16 | `localhost:5432`, banco `wagering` | `localhost:5433`, banco `wagering_test` |
| LocalStack 3 (SQS, SNS) | `localhost:4566` | `localhost:4567` |

Variáveis: `.env.example` (dev) e `.env.test` (testes). Nenhum segredo real.

O Postgres tem três papéis (D7.3): `postgres` só para o init do container, `wagering_owner` para as migrations (`DB_MIGRATION_USER`) e `wagering_app` para a aplicação e os testes (`DB_USER`), sem `UPDATE`/`DELETE` no ledger. Detalhes em [`src/modules/wagering/infra/persistence/README.md`](src/modules/wagering/infra/persistence/README.md).

O `scripts/localstack-init.sh` roda dentro do LocalStack quando ele fica pronto e cria:

| Recurso | Atributos | Decisão |
|---|---|---|
| `wager-transactions.fifo` | FIFO, deduplicação por conteúdo, redrive para a DLQ com `maxReceiveCount = 20` | D8.1, D8.3 |
| `wager-transactions-dlq.fifo` | FIFO | D8.2 |
| `wagering-events.fifo` (SNS) | tópico FIFO | D9.1 |
| `wagering-events-auditor.fifo` | FIFO, assinante do tópico (entrega raw) | D9.7 |

Por causa da deduplicação por conteúdo, a mensagem do §10 entra com só `--message-group-id` (D8.1):

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> \
  --message-body '<json do §10>'
```

O `awslocal` roda dentro do container; não precisa de Python na máquina.

O `.sh` tem que ter fim de linha LF (`.gitattributes`), senão quebra dentro do container.

## Partes

| Parte | README |
|---|---|
| Domínio (dinheiro, wallet, ledger, transação, eventos) | [`src/modules/wagering/README.md`](src/modules/wagering/README.md) |
| Persistência (schema, garantias no banco, ORM, migrations) | [`src/modules/wagering/infra/persistence/README.md`](src/modules/wagering/infra/persistence/README.md) |
| Configuração | [`src/shared/config/README.md`](src/shared/config/README.md) |
| Segredos | [`src/shared/secrets/README.md`](src/shared/secrets/README.md) |
| Logs | [`src/shared/logger/README.md`](src/shared/logger/README.md) |
| Health | [`src/shared/health/README.md`](src/shared/health/README.md) |

Os testes da infraestrutura de filas estão em `test/integration/localstack-infra.spec.ts`.
