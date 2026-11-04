# Arquitetura

Decisões, trade-offs e limitações do processador de transações de apostas (R-14-02, D11.5). Cada ponto cita o requisito (`R-…`, em [`docs/01-requisitos.md`](docs/01-requisitos.md)) e a decisão (`D…`, em [`docs/02-decisoes.md`](docs/02-decisoes.md)), onde estão o motivo completo e as alternativas descartadas. O detalhe de cada parte fica no README dela (tabela no fim). Setup e comandos: [`README.md`](README.md).

## Visão geral

Um serviço só (um código, um banco, D12.2), rodando como vários processos com a mesma imagem (D7.4): `api` ×3 atrás de um nginx, `consumer` ×3, `outbox-publisher` ×2, `pending-worker` ×2 e `event-auditor` ×1. O diagrama dos processos está no [`README.md`](README.md#processos).

- O HTTP (§9) e a fila (§10) chamam **o mesmo use case** (`SubmitWagerTransactionUseCase`, R-10-03).
- Toda escrita financeira acontece numa transação SQL só, aberta pelo use case: transação, saldo, ledger, inbox, outbox e a "cutucada" das pendentes (R-05-02, D6.5).
- Eventos nunca são publicados pelo use case: viram linhas da outbox na mesma transação, e o `outbox-publisher` os publica no SNS depois do commit (R-11-01, D9, D20.10).
- A correção vem do Postgres (locks, constraints, triggers), nunca de estado em memória. Nenhum lock global.

Camadas (lint do Biome): `domain/` é TypeScript puro; `application/` tem os use cases e as portas, sem ORM, AWS nem logger; `infra/` tem os adaptadores (D7.1, D20.10).

## ORM, `Money` e estratégia transacional (R-04-10)

**ORM: MikroORM 7** com `EntitySchema` (D7.1). As entidades do domínio não têm decorators; os schemas mapeiam records planos, e mappers convertem para o domínio. Escolhido por ser o preferencial do enunciado e ter Unit of Work explícito.

**`Money`** (D2.4): centavos em `bigint` do JavaScript mais a moeda. Nunca `number`: o lint proíbe `Number`, `parseInt`, `parseFloat` e `Math` no domínio, e um teste procura `toFixed` (D14.8).
- No banco: `numeric(20,2)` e `char(3)`. Um tipo customizado do MikroORM (`DecimalAmountType`) lê e grava o `numeric` **como string** (um `number` em qualquer direção lança erro), e o mapper monta o `Money` com a moeda da outra coluna, sem passar por `number`.
- Entrada (`Money.from`): 0 a 2 casas, até 12 dígitos inteiros, sem sinal, normalizada para 2 casas antes de tudo, inclusive do hash. Nada é arredondado: 3 casas é `400` (D2.1, D2.2).
- Internamente o `Money` pode ser negativo (`negate`, a diferença da reconciliação, D2.6).
- Saldo máximo de 15 dígitos inteiros (`BALANCE_LIMIT_EXCEEDED`, e um `CHECK` no banco, D15.2).

**Estratégia transacional:** o use case abre a transação pela porta `UnitOfWork` (`uow.run`), que o adaptador implementa com `em.transactional()`. Tudo dentro dela usa o mesmo `EntityManager`, e o flush acontece no commit. Todo horário gravado vem do `now()` da transação no banco (D18.12). Prazos do banco: `lock_timeout` 2 s, `statement_timeout` 5 s (D5).

## Concorrência (R-08-07, R-06-28)

**Lock pessimista na wallet** (`SELECT … FOR UPDATE`, D7.2), mais uma segunda camada no banco:
1. O use case trava a wallet e só então faz a checagem **autoritativa** de idempotência (D3.6). Uma duplicata simultânea espera o lock, encontra a original commitada e devolve replay. Com 50 requisições iguais em paralelo: 1 débito e 49 replays, todos `200` (R-13-C1).
2. Saldo, referência e idempotência são decididos sob o mesmo lock (R-13-C2, o cenário do §8).
3. A `version` sobe uma vez por mudança de saldo, só no domínio (`Wallet.debit/credit`). Sem o versionamento do ORM, a barreira contra um escritor sem lock é o `UNIQUE (wallet_id, wallet_version)` do ledger mais o trigger de cauda, que confere saldo e versão no commit (D15.1, D15.7).
4. Os índices únicos (key, id externo, uma reversão `PROCESSED` por referência) são a última barreira. Se um deles for violado, o use case repete uma vez e cai no replay ou no `409` (D3.6, D17.6).

**Ordem de locks** (sem deadlock): chave da inbox (só o consumidor, D19.4) → wallet → linhas de transação da mesma wallet. A "cutucada" das pendentes só alcança a própria wallet, com `SKIP LOCKED` (D4.4).

**Claims com `SKIP LOCKED` e lease com dono:** o worker de pendentes e o publisher pegam o trabalho numa transação curta e commitada, gravam o lease e o token do dono, e só seguram a wallet depois (D18.2, D18.10, D20.3, D20.5). Um lease vencido é retomado por outra instância. O dono conferido impede que duas instâncias gravem o mesmo resultado.

**Por que não otimista:** numa hot wallet (§14), o otimista com retry faz quase todas as tentativas falharem e repetirem. O lock serializa sem tempestade de retries, e as decisões que não são só de saldo (idempotência, referência) também precisam do mesmo lock.

**Medido:** `wallet_lock_wait_seconds{outcome}` e `wallet_lock_conflicts_total{reason}` (D22.5).

## Idempotência e `payloadHash` (R-09-14)

- `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` (D3.1, D3.2).
- `payloadHash` = SHA-256 (hex) do **JSON canônico** (chaves ordenadas em todos os níveis, sem espaços) de `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (normalizado) e `referenceExternalTransactionId` (omitido se ausente). Ficam de fora a key, o `messageId`, o `type` e o `occurredAt`, então o HTTP e a fila geram o mesmo hash para a mesma operação (D3.3). Exemplo e detalhes: [`application/README.md`](src/modules/wagering/application/README.md#payloadhash-r-09-14-d33).
- Mesma key e mesmo hash → replay com o **estado atual** da transação e `idempotentReplay: true` (D3.4). Mesma key com outro hash → `409 IDEMPOTENCY_KEY_CONFLICT`. Outra key com o mesmo id externo → `409 EXTERNAL_ID_CONFLICT`.
- Na fila, a inbox `(consumer_name, messageId)` é a primeira barreira; a key é a segunda (D3.7, D3.8, D19.4).

## Transições de estado (R-06-37)

| De | Para | Quem |
|---|---|---|
| `PENDING` (só em memória, nunca gravado) | `PROCESSED`, `REJECTED`, `PENDING_REFERENCE` | submissão (HTTP ou fila), na mesma transação (D4.1) |
| `PENDING_REFERENCE` | `PROCESSED`, `REJECTED` | worker, ao resolver a referência ou no prazo (D4.3) |
| `PENDING_REFERENCE` | `FAILED` (`PROCESSING_FAILED`) | só o worker, depois de 5 erros seguidos não transitórios (D4.2, D18.4) |
| `PROCESSED`, `REJECTED`, `FAILED` | — | terminais, nunca mudam |

No banco: o `CHECK` de status recusa `PENDING`; um trigger de `INSERT` recusa `FAILED`; um trigger de `UPDATE` recusa qualquer mudança de linha terminal e das colunas da submissão (D15.3, D15.5). Diagrama: [`src/modules/wagering/README.md`](src/modules/wagering/README.md#estados-da-transação).

## Referências fora de ordem e prazo das pendências (R-07-21)

- Referência ausente, ou ainda pendente → `PENDING_REFERENCE` (`202`). O evento `WagerTransactionPendingReference` sai uma vez, ao entrar no estado (D4.6).
- O `pending-worker` pega as vencidas a cada 1 s, com backoff exponencial de 1 s dobrando até 60 s (D4.3).
- **Prazo: 15 minutos** desde a criação. Esgotado: `REJECTED` com `REFERENCE_NOT_FOUND` e evento. O prazo cobre a janela de reenvio do consumidor (8 tentativas com backoff até 300 s) com folga.
- Quando uma transação chega a um estado terminal, o use case "cutuca" as pendentes da mesma wallet que a referenciam (`next_attempt_at = now()`), e o worker as resolve em cerca de 1 s (D4.4, D18.6).
- Duas reversões esperando a mesma referência: a mais antiga vence (D18.9), e só uma é aplicada (D1.1).

## Taxonomia de erros e status HTTP (R-07-31, R-09-17)

**Fronteira:** decidível só pelo payload → `400`, não grava. Depende do banco → `REJECTED` gravado (`422`). Wallet inexistente → `404`, não grava (D5).

| `failureCode` | Quando | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` sem saldo | desistir |
| `INSUFFICIENT_FUNDS_FOR_REVERSAL` | reversão que deixaria o saldo negativo | reenviar depois, com outro id |
| `CURRENCY_MISMATCH` | moeda ≠ moeda da wallet | corrigir |
| `WALLET_PLAYER_MISMATCH` | wallet de outro `playerId` | corrigir |
| `REFERENCE_NOT_FOUND` | prazo da pendência esgotado | corrigir ou desistir |
| `REFERENCE_SCOPE_MISMATCH` | referência de outro player, wallet, moeda ou rodada (`failureDetail` diz qual) | corrigir |
| `REFERENCE_KIND_NOT_ALLOWED` | tipo de referência não permitido | corrigir |
| `REFERENCE_NOT_PROCESSED` | referência `REJECTED`/`FAILED` | desistir |
| `REFERENCE_ALREADY_REVERSED` | já tem reversão `PROCESSED` | desistir |
| `AMOUNT_MISMATCH` | valor ≠ valor da referência | corrigir |
| `BALANCE_LIMIT_EXCEEDED` | saldo passaria do teto | desistir |
| `PROCESSING_FAILED` | `FAILED` (só o worker) | contatar o operador (`500`, D16.4) |

A ordem das checagens é fixa, e a primeira violação vence (D14.2). "Reenviar igual" nunca é o conselho: a mesma key devolve replay.

| Status | Quando |
|---|---|
| `200` | `PROCESSED` (inclusive `LOSS`), consultas, reconciliação |
| `201` | wallet criada |
| `202` | `PENDING_REFERENCE` |
| `400 VALIDATION_ERROR` | payload, cursor ou parâmetro inválido |
| `401` / `403` | sem token ou token inválido / sem permissão ou `providerId` do corpo ≠ token |
| `404` | inexistente, ou de outro provedor |
| `409` | `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_ID_CONFLICT`, `WALLET_ALREADY_EXISTS` |
| `422` | `REJECTED`, com o `failureCode` |
| `500` | `PROCESSING_FAILED`, `INTERNAL_ERROR` |
| `503` + `Retry-After: 1` | banco fora, `lock_timeout`, prazo da requisição, JWKS indisponível |

Na fila, a mesma taxonomia vira ação (D8.2, D19): negócio (`REJECTED`, `PENDING_REFERENCE`, replay) → ack; permanente (schema, wallet inexistente, conflito de inbox ou de key) → cópia intacta para a DLQ na hora; transitório → backoff de 2ⁿ s até 300 s, contado em `message_attempts`, DLQ na 8ª tentativa. Todo erro passa por `classifyError()`.

## Prazos

| Prazo | Valor | Decisão |
|---|---|---|
| `lock_timeout` | 2 s | D5 |
| `statement_timeout` | 5 s | D5 |
| requisição HTTP | 10 s → `503` (o trabalho não é cancelado; o reenvio cai no replay) | D21.3 |
| nginx (`proxy_read_timeout`) | 15 s | D21.3 |
| pendência | 15 min, backoff 1 s → 60 s | D4.3 |
| lease do worker e do publisher | 30 s | D18.2, D20.5 |
| visibilidade do consumidor / long poll | 120 s / 20 s | D19.6 |
| tentativas transitórias na fila | 8, depois DLQ; rede de segurança `maxReceiveCount = 20` | D8.3 |
| SNS / comandos SQS | 10 s / 5 s, uma tentativa por chamada | D20.5, D21.12 |
| health (cada dependência) | 1 s | D11.3 |
| shutdown | 30 s (Compose); consumidor até 25 s | D8.5, D19.9 |

## Outbox e eventos (§11)

- Linhas da outbox gravadas na transação do use case. O `outbox-publisher` pega só a **cabeça** de cada wallet (o evento mais antigo não publicado), com `SKIP LOCKED` e lease, e publica no tópico SNS FIFO `wagering-events.fifo` com `MessageGroupId = walletId`. Os eventos de uma wallet saem em ordem; wallets diferentes saem em paralelo (D9.1, D9.2, D20.3).
- **Classes do §6.5** (D24): `InboxMessage` e `OutboxMessage` ficam em `src/modules/wagering/domain/`. Elas guardam o estado e as transições: receber e processar; enfileirar, publicar e reagendar com backoff de 2ⁿ s até 300 s; alerta a partir de 20 tentativas. Os adaptadores criam as linhas por elas. O SQL continua com o que precisa valer entre instâncias: o claim por cabeça de wallet com `SKIP LOCKED`, o lease, o dono (`locked_by`), o filtro de vencidos e o relógio (`now()` do banco, D18.12). Uma regra em memória não impede dois processos de pegarem a mesma linha; o banco impede.
- Falha: backoff até 5 min. **Nunca descarta**: depois de 20 tentativas, alerta (log `error` e métrica), e continua tentando (D9.6, D20.4).
- Entrega pelo menos uma vez: uma publicação dupla (lease vencido) é segura. O `event-auditor` deduplica pelo `eventId` com a mesma inbox e confere a ordem por `(wallet, tipo de evento)` (D9.7, D20.1).
- Eventos: os 4 do enunciado, mais `WalletOpened` e `WagerTransactionFailed` (D9.4, D14.4).

## Autenticação (R-02-03)

IdP externo: **Keycloak**, com OAuth2 `client_credentials` (D10.1, D23):
- realm `wagering`, com um client por provedor (`provider-a`, `provider-b`) e um client `operator`;
- o papel vem em `realm_access.roles` e o provedor no claim `provider_id` (D16.1);
- a api valida com `jose`: JWKS, emissor, audiência `wagering-api`, expiração e só `RS256`.

Permissões (D10.2):
- O operador cria wallets e reconcilia.
- O provedor submete só com o próprio `providerId` (senão `403`) e consulta só as próprias transações (as de outro provedor dão `404`).

Não existe chave para desligar a autenticação. Os testes usam um emissor de teste com o mesmo adaptador, e um e2e roda contra o Keycloak real (D10.3, D23.5). Health e `/docs` são abertos, e a fila não tem auth (R-02-06, R-02-07). Detalhes: [`src/shared/auth/README.md`](src/shared/auth/README.md), [`keycloak/README.md`](keycloak/README.md).

## Garantias no banco (§5.9, D7.3, D15)

O Postgres garante as invariantes do §6 mesmo contra SQL direto:
- unicidades;
- `CHECK` de saldo, valores e aritmética do lançamento;
- ledger append-only (trigger, e o papel da app não tem `UPDATE`/`DELETE`);
- encadeamento `balance_before` = `balance_after` anterior;
- trigger diferido de cauda (saldo e `version` = último lançamento);
- coerência lançamento × transação;
- FKs compostas de wallet, moeda e rodada da referência;
- máquina de estados.

Cada garantia tem um teste que tenta violá-la, e `bun run test:proofs` remove 14 proteções, uma por vez, exigindo que um teste nomeado falhe. Detalhes: [`persistence/README.md`](src/modules/wagering/infra/persistence/README.md), [`proofs/README.md`](proofs/README.md).

## Interpretações (R-07-15)

- Sem estado de rodada: várias `BET`s por rodada, `WIN`/`LOSS` sem `BET`, vários `WIN`s e `REFUND` depois de `WIN` são permitidos (D1.6). Um `REFUND` de `BET` já liquidada é aplicado e sinalizado (`refund_after_settlement`, métrica e log, D1.7, D22.8).
- Uma transação é revertida **no máximo uma vez, por qualquer tipo**: `REFUND` + `ROLLBACK` da mesma `BET` creditaria duas vezes (D1.1). Só uma reversão `PROCESSED` bloqueia outra: uma reversão rejeitada por saldo pode ser reenviada (D1.3).
- `ROLLBACK` de `REFUND` debita (o inverso da referência). Cadeia máxima: `BET ← REFUND ← ROLLBACK` (D1.2).
- Toda transação com referência exige a referência `PROCESSED`. Se ela estiver pendente, a transação espera; se estiver `REJECTED`/`FAILED`, `REFERENCE_NOT_PROCESSED` na hora. Por exemplo, um `WIN` de uma `BET` rejeitada não paga (D1.4).
- Referência obrigatória em `REFUND`/`ROLLBACK`, opcional em `WIN`/`LOSS` (aponta para uma `BET`, sem conferir valor), proibida na `BET` (D1.5, D14.9).
- `LOSS` aceita valor 0 e não gera lançamento; os outros kinds exigem valor > 0 (D2.3).
- `amount` com 0 a 2 casas é aceito e normalizado: `"25"` e `"25.00"` são a mesma operação (D2.1). Moedas aceitas: `BRL` e `USD`, configuráveis, só moedas de 2 casas (D2.5).
- A wallet nasce com `version: 1`, com ou sem `OPENING`; saldo inicial 0 não gera `OPENING` (D6.2, D2.3). `initialBalance` é obrigatório: dele vem a moeda (D6.7).
- Processamento síncrono: `PENDING` nunca é gravado. "Aceite com processamento pendente" = `PENDING_REFERENCE` (D4.1).
- Replay devolve o estado **atual**: uma pendente resolvida devolve o resultado novo (D3.4).
- Uma mensagem que vai para a DLQ não cria transação; a DLQ é o registro (D4.2).
- O `playerId` é qualquer string de 1 a 128 caracteres `[A-Za-z0-9._:-]`, sem cadastro de jogadores (D6.4).
- A reconciliação não corrige nada: responde `consistent: false` com `issues`, loga e conta em métrica (D6.9, D16.5).

## Trade-offs

| Escolha | Ganho | Custo |
|---|---|---|
| Lock pessimista na wallet (D7.2) | hot wallet sem tempestade de retries; todas as decisões sob o mesmo lock | throughput de uma wallet limitado pela serialização |
| Processamento síncrono (D4.1) | resposta imediata com saldo, como no §9 | a requisição espera o lock (até 2 s, depois `503`) |
| Outbox + publisher (D9) | nenhum evento antes do commit; nenhum evento perdido | latência de publicação (claim a cada 500 ms se vazio) e um processo a mais |
| Ordem por wallet no publisher (D9.2) | consumidores recebem em ordem | um evento travado segura os seguintes da mesma wallet |
| Garantias no banco (D7.3, D15) | invariantes valem contra bug e SQL direto | migrations e triggers mais complexos |
| SNS FIFO em vez de fila direta (D9.1) | fan-out para novos consumidores sem mexer no publisher | deduplicação do SNS em 5 min esconde duplicatas nos testes (D20.6) |
| Um serviço com vários processos (D12.2) | atomicidade numa transação só | os papéis escalam juntos no mesmo banco |

## Limitações

- **Cadeia de reversão limitada:** depois de `BET ← REFUND ← ROLLBACK`, a `BET` não pode ser revertida de novo (o "estado líquido" não cabe num índice único, D1.2).
- **Readiness depende do SQS:** com o SQS fora, a api continua funcionando (o HTTP não usa a fila), mas a readiness fica falsa (L533). O nginx não roteia pela readiness; um orquestrador que roteasse tiraria a api do ar (D5, B7.7).
- **Morte durante o long poll:** se um consumidor morrer à força durante um `ReceiveMessage`, as mensagens recebidas ficam invisíveis até a visibilidade de 120 s vencer, sem perda nem duplicação (D19.9).
- **Redrive do SQS fora do contador de DLQ:** uma mensagem movida pelo `maxReceiveCount = 20` aparece só no gauge de profundidade, não em `wagering_dlq_messages_total` (D22.4).
- **"Liquidada" só por referência:** um `WIN`/`LOSS` sem referência não marca a `BET` como liquidada para o `refund_after_settlement` (D22.8).
- **Publicação dupla possível:** com um lease vencido no meio da publicação, um evento pode sair duas vezes; o consumidor deduplica pelo `eventId` (D20.5).
- **`SIGTERM` real só testado fora do Windows:** o teste com o sinal real é pulado no Windows, e ainda não há CI. A conferência à mão com `docker stop` nos 11 processos está registrada na D21.2.
- **Seed só no dev:** a wallet do exemplo do §9 é criada por um seed do Compose de dev, para os exemplos funcionarem como estão escritos (D23.1); em produção não existe seed.
- **Segredos de dev:** os segredos dos clients do Keycloak e o admin estão no repositório e são só de desenvolvimento. Em produção, viriam de um cofre (o encaixe `SecretsProvider`, D12.3).
- **Sem teste de carga ainda:** o k6 (`bun run test:load`) é um extra (D11.6).

## Onde está cada parte

| Parte | README |
|---|---|
| Domínio (dinheiro, wallet, ledger, transação, eventos, estados) | [`src/modules/wagering/README.md`](src/modules/wagering/README.md) |
| Use cases (submissão, pendentes, wallet, reconciliação, hash) | [`src/modules/wagering/application/README.md`](src/modules/wagering/application/README.md) |
| Persistência (schema, garantias, ORM, migrations, papéis) | [`src/modules/wagering/infra/persistence/README.md`](src/modules/wagering/infra/persistence/README.md) |
| API HTTP (endpoints, permissões, cursor; Swagger em `/docs`) | [`src/modules/wagering/infra/http/README.md`](src/modules/wagering/infra/http/README.md) |
| Consumidor SQS (inbox, DLQ, tentativas, shutdown) | [`src/modules/wagering/infra/messaging/README.md`](src/modules/wagering/infra/messaging/README.md) |
| Outbox, publisher e auditor | [`src/modules/wagering/infra/outbox/README.md`](src/modules/wagering/infra/outbox/README.md) |
| Worker de pendentes | [`src/modules/wagering/infra/workers/README.md`](src/modules/wagering/infra/workers/README.md) |
| Autenticação e Keycloak | [`src/shared/auth/README.md`](src/shared/auth/README.md), [`keycloak/README.md`](keycloak/README.md) |
| Erros (`classifyError`) | [`src/shared/errors/README.md`](src/shared/errors/README.md) |
| Logs e métricas | [`src/shared/logger/README.md`](src/shared/logger/README.md), [`src/shared/metrics/README.md`](src/shared/metrics/README.md) |
| Config, segredos, health, HTTP comum, ORM, AWS | [`config`](src/shared/config/README.md), [`secrets`](src/shared/secrets/README.md), [`health`](src/shared/health/README.md), [`http`](src/shared/http/README.md), [`orm`](src/shared/orm/README.md), [`aws`](src/shared/aws/README.md) |
| nginx | [`nginx/README.md`](nginx/README.md) |
| Testes e provas | [`test/README.md`](test/README.md), [`proofs/README.md`](proofs/README.md) |
