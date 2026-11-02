# distributed-wagering-processor

Processador distribuído de transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`), recebidas por HTTP e por SQS. O foco é correção financeira, concorrência e idempotência.

- Enunciado: [`docs/CHALLENGE.md`](docs/CHALLENGE.md)
- Arquitetura, decisões, trade-offs e limitações: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Requisitos, decisões e plano: [`docs/01-requisitos.md`](docs/01-requisitos.md), [`docs/02-decisoes.md`](docs/02-decisoes.md), [`docs/03-plano.md`](docs/03-plano.md)
- Como foi feito com IA: [`AI_WORKFLOW.md`](AI_WORKFLOW.md)

## Requisitos

- [Bun](https://bun.sh) 1.x
- Docker com Docker Compose
- `curl` (já vem no Linux, no macOS e no Windows 10+)

Portas usadas pelo Compose de dev: 3000 (api), 5432 (Postgres), 4566 (LocalStack) e 8080 (Keycloak).

## Começo rápido

```bash
git clone <url-do-repositório> distributed-wagering-processor
cd distributed-wagering-processor
bun install
bun run infra:up          # (re)constrói a imagem e sobe tudo (a 1ª vez demora alguns minutos)
bun run acceptance        # roda os exemplos do §9 e do §10 como estão escritos
```

O `bun run acceptance` espera a api ficar pronta (até 3 min), pede os tokens ao Keycloak e roda, nesta ordem:
- a criação de wallet e a BET do §9, literais, com o header `Authorization`;
- a mensagem do §10, literal, só com `--message-group-id`;
- as consultas e a reconciliação.

Cada passo é conferido, e qualquer divergência faz o comando sair com erro. O §10 é conferido pela linha da inbox do consumidor (`msg-123`), consultada com o papel da app dentro do container do Postgres. Pode rodar de novo: o resultado é o mesmo, com `idempotentReplay: true`, e o §10 avisa que a inbox já tinha a mensagem, sem afirmar um novo processamento (D23.6). `ACCEPTANCE_API_URL` e `ACCEPTANCE_KEYCLOAK_URL` trocam os hosts, se precisar (D23.7). A aceitação fica fora do `bun run check`, porque precisa do Compose de dev completo.

## Comandos

```bash
bun install

bun run infra:up          # Compose completo (topologia da D7.4, abaixo), com Keycloak e seed; `--build`: sempre o código atual (D23.8)
bun run infra:down
bun run infra:test:up     # infraestrutura dos testes (portas separadas, com Keycloak de teste)
bun run infra:test:down

bun run migration:up      # aplica as migrations (papel dono)
bun run migration:down    # desfaz todas
bun run migration:verify  # up → down → up no banco de teste

bun run check             # typecheck + lint + unit + migration:verify + integração + concorrência + e2e
bun run test:e2e          # e2e com o Keycloak real (D10.3, D23.5)
bun run test:repeat concurrency 10   # n rodadas seguidas; resumo sempre e log de cada falha em logs/test-repeat/
bun run test:proofs       # remove cada proteção e exige que o teste dela falhe (proofs/README.md)
bun run acceptance        # exemplos do §9 e do §10, literalmente, contra o Compose de dev
```

`bun run check` e `bun run test:proofs` precisam da infraestrutura de teste no ar (`bun run infra:test:up`); alguns testes também usam o Docker direto (um Postgres próprio, D21.7, e o `docker compose config`). No Compose de dev, o serviço `migrate` aplica as migrations antes dos processos subirem.

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

## Exemplos do enunciado (§9 e §10)

### Token (Keycloak, D10.1, D23)

O Keycloak (`localhost:8080`) importa o realm `wagering` do repositório ([`keycloak/README.md`](keycloak/README.md)) e emite tokens por `client_credentials`. **Os segredos abaixo são de desenvolvimento, não segredos reais.**

| Client | Segredo | Papel | Pode |
|---|---|---|---|
| `operator` | `operator-dev-secret` | `operator` | criar wallet, reconciliar, consultar tudo |
| `provider-a` | `provider-a-dev-secret` | `provider` (`provider_id = provider-a`) | submeter com `providerId: provider-a`, consultar as próprias transações e as wallets |
| `provider-b` | `provider-b-dev-secret` | `provider` (`provider_id = provider-b`) | o mesmo, como `provider-b` |

Linux, macOS ou Git Bash:

```bash
token() {
  curl -s -X POST http://localhost:8080/realms/wagering/protocol/openid-connect/token \
    -d grant_type=client_credentials -d client_id="$1" -d client_secret="$1-dev-secret" \
    | sed -E 's/.*"access_token":"([^"]+)".*/\1/'
}
OPERATOR_TOKEN=$(token operator)
PROVIDER_TOKEN=$(token provider-a)
```

PowerShell:

```powershell
function Get-Token($client) {
  (Invoke-RestMethod -Method Post -Uri http://localhost:8080/realms/wagering/protocol/openid-connect/token `
    -Body @{ grant_type = "client_credentials"; client_id = $client; client_secret = "$client-dev-secret" }).access_token
}
$OPERATOR_TOKEN = Get-Token operator
$PROVIDER_TOKEN = Get-Token provider-a
```

O token vale 5 minutos. O emissor (`iss`) é sempre `http://localhost:8080/realms/wagering`, qualquer que seja o host usado para pedi-lo (D23.3).

### A wallet do exemplo já existe (seed, D23.1)

A BET do §9 e a mensagem do §10 usam a wallet `0192f291-27dd-7d3f-8071-5f8685deef37`, mas o `POST /wallets` gera um id novo a cada wallet (UUIDv7, D6.6). Para os exemplos funcionarem como estão escritos, o serviço `seed` do Compose de dev cria essa wallet antes da api subir. Ele usa o mesmo use case do `POST /wallets`, com o mesmo id do enunciado, o player `0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1` e `1000.00 BRL`. Por isso:
- a **criação literal** do §9 devolve `409 WALLET_ALREADY_EXISTS` com esse `walletId`. É o conflito que o §9 pede para "wallet duplicada para o mesmo `playerId` + `currency`";
- a **BET** e o **§10** funcionam como estão escritos.

O seed existe só no Compose de dev, e rodá-lo de novo não faz nada. Se o banco já tiver uma wallet desse player com **outro** id (por exemplo, criada pelo `curl` do §9 num volume antigo), o seed falha com `SEED_EXAMPLE_WALLET_MISMATCH` e a api não sobe. Para recomeçar com o banco limpo:

```bash
bun run infra:down -v && bun run infra:up
```

### §9 Criar wallet

Literal (devolve `409`, porque o seed já criou essa wallet):

```bash
curl -i -X POST http://localhost:3000/wallets \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}'
# 409 {"error":{"code":"WALLET_ALREADY_EXISTS",...,"details":{"walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}}}
```

Para ver o `201`, a mesma criação com outro `playerId`:

```bash
curl -i -X POST http://localhost:3000/wallets \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
  "playerId": "player-readme-1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}'
# 201 {"id":"<uuid v7 novo>","playerId":"player-readme-1","balance":{"amount":"1000.00","currency":"BRL"},"version":1}
```

### §9 Submeter transação

```bash
curl -i -X POST http://localhost:3000/wagering/transactions \
  -H "Authorization: Bearer $PROVIDER_TOKEN" \
  -H "Idempotency-Key: provider-a:transaction-123" \
  -H "Content-Type: application/json" \
  -d '{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}'
# 200 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

Repetir o mesmo comando devolve o mesmo corpo, com `"idempotentReplay": true`.

### §9 Consultas e reconciliação

```bash
curl -s http://localhost:3000/wallets/0192f291-27dd-7d3f-8071-5f8685deef37 -H "Authorization: Bearer $OPERATOR_TOKEN"
curl -s "http://localhost:3000/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/ledger?limit=50" -H "Authorization: Bearer $OPERATOR_TOKEN"
curl -s http://localhost:3000/wagering/transactions/<transactionId> -H "Authorization: Bearer $PROVIDER_TOKEN"
curl -s http://localhost:3000/providers/provider-a/wagering/transactions/transaction-123 -H "Authorization: Bearer $PROVIDER_TOKEN"
curl -s -X POST http://localhost:3000/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/reconciliation -H "Authorization: Bearer $OPERATOR_TOKEN"
curl -s http://localhost:3000/health/live      # sem token
curl -s http://localhost:3000/health/ready     # sem token
```

A documentação de todos os endpoints, com corpos e status, está no Swagger: <http://localhost:3000/docs>.

### §10 Mensagem na fila

A mensagem do §10, exatamente como está, só com `--message-group-id` (a fila tem deduplicação por conteúdo, D8.1). O `awslocal` roda dentro do container, então não precisa de Python na máquina:

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id 0192f291-27dd-7d3f-8071-5f8685deef37 \
  --message-body '{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}'
```

É a mesma operação da BET do §9 (mesma key, mesmo `payloadHash`, D3.3). Se a BET já foi enviada por HTTP, o consumidor dá ack num replay e o saldo continua `975.00`, com um único débito no ledger. Se a mensagem chegar primeiro, ela debita, e o `curl` da BET devolve o replay. O `MessageGroupId` recomendado é o `walletId` (ordem por wallet), mas qualquer grupo é aceito (D8.1).

## Processos

Um serviço só (um código, um banco, D12.2) rodando como vários processos com a mesma imagem e entrypoints diferentes (D7.4). Todos falam com o mesmo Postgres; a correção vem dos locks e das garantias do banco, nunca de estado em memória.

```mermaid
flowchart LR
    provider([Provedor]) -- "HTTP :3000" --> nginx
    provider -- "SendMessage (§10)" --> q[["SQS wager-transactions.fifo"]]
    nginx --> api1[api-1] & api2[api-2] & api3[api-3]
    q --> consumer["consumer ×3"]
    q -. "permanente / limite" .-> dlq[["DLQ"]]
    api1 & api2 & api3 & consumer -- "mesmo use case:<br/>transação, ledger, outbox, inbox<br/>numa transação SQL" --> pg[(PostgreSQL)]
    worker["pending-worker ×2"] -- "claim SKIP LOCKED + lease;<br/>resolve as pendentes" --> pg
    publisher["outbox-publisher ×2"] -- "claim da cabeça de cada wallet<br/>(SKIP LOCKED + lease)" --> pg
    publisher -- "Publish (grupo = walletId)" --> sns{{"SNS wagering-events.fifo"}}
    sns --> aq[["SQS wagering-events-auditor.fifo"]]
    aq --> auditor["event-auditor ×1"]
    auditor -- "inbox + audited_events" --> pg
```

| Processo | Instâncias | Entrypoint | O que faz | Como as instâncias não se atrapalham |
|---|---|---|---|---|
| `nginx` | 1 | — | balanceia as 3 `api` na porta 3000; repete numa outra só erro de conexão (nunca um POST que já chegou) | — |
| `api` | 3 | `main-api.ts` | HTTP (§9) | lock da wallet + idempotência sob o lock (D3.6, D7.2) |
| `consumer` | 3 | `main-consumer.ts` | fila do §10, o mesmo use case do HTTP | inbox por `messageId` + lock da wallet (D3.7, D19.4) |
| `outbox-publisher` | 2 | `main-outbox-publisher.ts` | publica a outbox no SNS, em ordem por wallet | claim da cabeça com `SKIP LOCKED`, lease e dono (D20.3, D20.5) |
| `pending-worker` | 2 | `main-pending-worker.ts` | resolve as `PENDING_REFERENCE` | claim com `SKIP LOCKED`, lease e dono (D18.2, D18.10) |
| `event-auditor` | 1 | `main-event-auditor.ts` | confere a ordem e deduplica os eventos | inbox por `eventId` (D9.7, D20.1) |

**Shutdown (D8.5, D8.6, D21.2).** O bun é o PID 1 de cada container (`ENTRYPOINT`/`CMD` em forma exec, testado em `test/integration/infra/compose-topology.spec.ts`), então o `SIGTERM` do `docker compose stop` chega a ele, e o Compose dá 30 s para parar:
- `api`: readiness falsa, para de aceitar, termina as requisições em andamento (até 10 s) e só então fecha o banco;
- `consumer` e `event-auditor`: terminam o lote ou o long poll e devolvem o que não começaram (D19.9);
- `outbox-publisher` e `pending-worker`: terminam o item atual; os leases dos outros vencem sozinhos.

Morto à força no meio da carga, nada se perde nem duplica: a transação desfeita volta pela reentrega ou pelo reenvio do provedor (mesma key), o lease vence e outra instância continua. É o R-13-C8, provado com todos os processos separados em `test/concurrency/restart.spec.ts`.

**Prazos.** Cada requisição tem 10 s (`HTTP_REQUEST_TIMEOUT_MS`, D21.3): estourado, `503` com `Retry-After: 1`; o trabalho não é cancelado e o reenvio com a mesma key cai no replay; o desfecho tardio (commitou ou falhou) vai para o log, com `correlationId` e `idempotencyKey`. O nginx (`nginx:1.27.5-alpine`, versão exata ≥ 1.27.3 por causa do `resolve` no upstream, [`nginx/README.md`](nginx/README.md)) espera 15 s, para o `503` da api chegar antes do `504` dele. Lease do worker e visibilidade do consumidor são configuráveis e validados na subida contra o tamanho do lote (D21.6); ver [`src/shared/config/README.md`](src/shared/config/README.md).

**Onde está provado:**

| Requisito | Teste |
|---|---|
| R-13-C4, R-05-08, R-08-06: 3 processos na mesma wallet | `test/concurrency/multi-instance.spec.ts` (3 `api` + 3 `consumer` reais; o lock só é solto com as 3 `api` e pelo menos 1 `consumer` esperando no `pg_locks`, por `application_name`, D21.1) |
| R-13-C6: dois publishers em processos separados | `test/concurrency/outbox-processes.spec.ts` (D21.4) |
| R-13-C8, R-13-I6: reinício no meio da carga | `test/concurrency/restart.spec.ts` (topologia inteira; cada processo morto com trabalho em andamento visto no banco, D21.11; reconciliação de todas as wallets do teste, D21.5) |
| D5, R-13-I6: Postgres fora e reiniciado | `test/integration/failures/postgres-restart.spec.ts` (Postgres próprio do teste, D21.7) |
| D5, B7.7: SQS fora | `test/integration/failures/sqs-down.spec.ts` |
| D5, D21.3: prazo da requisição | `test/integration/http/request-timeout.spec.ts` |
| D8.6: shutdown | `test/integration/shutdown/shutdown.spec.ts`; sinal real em `sigterm.spec.ts`, que só roda fora do Windows; ainda não há CI (é o primeiro extra, depois da S10), então até lá a prova do sinal real é a conferência à mão com `docker stop` nos 11 processos, saída 0 ([`test/README.md`](test/README.md)) |

## Infraestrutura

| Serviço | Dev (`docker-compose.yml`) | Testes (`docker-compose.test.yml`) |
|---|---|---|
| nginx (api ×3) | `localhost:3000` | — (os testes sobem a api no próprio processo ou em processos separados) |
| Postgres 16 | `localhost:5432`, banco `wagering` | `localhost:5433`, banco `wagering_test` |
| LocalStack 3 (SQS, SNS) | `localhost:4566` | `localhost:4567` |
| Keycloak 26.7.5 (realm `wagering`) | `localhost:8080` (admin `admin`/`admin`, só dev) | `localhost:8081` (só o e2e) |
| `migrate` (one-shot) | aplica as migrations com o papel dono | — (o preload dos testes aplica) |
| `seed` (one-shot) | cria a wallet do exemplo do §9/§10 (D23.1) | — |

Variáveis: `.env.example` (dev) e `.env.test` (testes). Nenhum segredo real: as senhas do banco, o admin do Keycloak e os segredos dos clients são de desenvolvimento.

O Postgres tem três papéis (D7.3): `postgres` só para o init do container, `wagering_owner` para as migrations (`DB_MIGRATION_USER`) e `wagering_app` para a aplicação e os testes (`DB_USER`), sem `UPDATE`/`DELETE` no ledger. Detalhes em [`src/modules/wagering/infra/persistence/README.md`](src/modules/wagering/infra/persistence/README.md).

O `scripts/localstack-init.sh` roda dentro do LocalStack quando ele fica pronto e cria:

| Recurso | Atributos | Decisão |
|---|---|---|
| `wager-transactions.fifo` | FIFO, deduplicação por conteúdo, redrive para a DLQ com `maxReceiveCount = 20` | D8.1, D8.3 |
| `wager-transactions-dlq.fifo` | FIFO | D8.2 |
| `wagering-events.fifo` (SNS) | tópico FIFO | D9.1 |
| `wagering-events-auditor.fifo` | FIFO, assinante do tópico (entrega raw) | D9.7 |

Por causa da deduplicação por conteúdo, a mensagem do §10 entra com só `--message-group-id` (D8.1); o comando completo está em [§10 Mensagem na fila](#10-mensagem-na-fila).

O `.sh` tem que ter fim de linha LF (`.gitattributes`), senão quebra dentro do container.

## Partes

| Parte | README |
|---|---|
| Domínio (dinheiro, wallet, ledger, transação, eventos) | [`src/modules/wagering/README.md`](src/modules/wagering/README.md) |
| Persistência (schema, garantias no banco, ORM, migrations) | [`src/modules/wagering/infra/persistence/README.md`](src/modules/wagering/infra/persistence/README.md) |
| Use cases (abrir wallet, consultas, reconciliação) | [`src/modules/wagering/application/README.md`](src/modules/wagering/application/README.md) |
| API HTTP das wallets (endpoints, permissões, cursor) — Swagger em `/docs` | [`src/modules/wagering/infra/http/README.md`](src/modules/wagering/infra/http/README.md) |
| Autenticação (JWT, papéis, guard) | [`src/shared/auth/README.md`](src/shared/auth/README.md) |
| Keycloak (realm, clients, emissor) | [`keycloak/README.md`](keycloak/README.md) |
| Erros → HTTP (`classifyError`) | [`src/shared/errors/README.md`](src/shared/errors/README.md) |
| HTTP comum (correlação, validação, Swagger) | [`src/shared/http/README.md`](src/shared/http/README.md) |
| Métricas | [`src/shared/metrics/README.md`](src/shared/metrics/README.md) |
| Configuração | [`src/shared/config/README.md`](src/shared/config/README.md) |
| Segredos | [`src/shared/secrets/README.md`](src/shared/secrets/README.md) |
| Logs | [`src/shared/logger/README.md`](src/shared/logger/README.md) |
| Health | [`src/shared/health/README.md`](src/shared/health/README.md) |
| Testes (suítes, regras, processos separados, plataforma) | [`test/README.md`](test/README.md) |
| Provas (cada proteção removida derruba um teste) | [`proofs/README.md`](proofs/README.md) |
| nginx (balanceador das 3 api) | [`nginx/README.md`](nginx/README.md) |

Os testes da infraestrutura de filas estão em `test/integration/localstack-infra.spec.ts`.
