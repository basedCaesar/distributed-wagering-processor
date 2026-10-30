# 01 — Requisitos (congelados)

**Status:** congelado em 28/10/2026, depois de duas auditorias em contexto limpo.

Fonte: `docs/CHALLENGE.md`, cópia literal do README de `junglegaming/backend-challenge`, commit `c7143e6` (29/07/2026), sha256 `47795fce…3812e`. `Lx` = linha nesse arquivo.

**Regras deste documento** (são regras de processo, não vêm do enunciado)
- A coluna "Texto" é **cópia literal** do enunciado, com duas exceções sinalizadas:
  - itens de uma lista unidos numa linha, separados por `;`;
  - blocos de código e de JSON, marcados com *(resumo)* e o intervalo de linhas. Para eles, **o bloco original no `CHALLENGE.md` é o que vale**.
- Ambiguidades, escolhas e silêncios ficam na **Parte B**, que aponta para os IDs da Parte A e para as linhas. Eles são resolvidos no passo 2 (decisões), nunca aqui.
- Depois de aprovado, este arquivo só muda se o enunciado mudar.
- A descrição da vaga (Parte C) não cria exigência do desafio. Em caso de conflito, a Parte A vence.

**Tipos (Parte A)**

| Tipo | Significado |
|---|---|
| `OBRIG` | Obrigatório. |
| `PROIB` | Proibido. Inclui as restrições invioláveis do §5. |
| `ELIM` | Falha eliminatória (§14). |
| `ESCOLHA` | O enunciado deixa a decisão para o candidato. Quando o texto também impõe condições ("desde que…", "documente"), o tipo é `ESCOLHA + OBRIG`. |
| `CONTRATO` | Formato dos contratos HTTP e da fila. O exemplo precisa funcionar como está escrito. |
| `ESQUELETO` | Esqueleto de referência do §6. Pela L104 e pela L111, nomes e assinaturas podem ser adaptados, mas as garantias e o encapsulamento são obrigatórios. |
| `EXEMPLO` | Exemplo ilustrativo do próprio enunciado. |
| `OPC` | Opcional ou diferencial. |
| `CONTEXTO` | Informação de fundo, sem exigência própria. |

Tipos compostos (`ESCOLHA + OBRIG`, `EXEMPLO + CONTRATO`) e qualificados (`OBRIG (se implementar)`, `OBRIG (critério de avaliação)`) combinam os significados acima.

---

# Parte A — Requisitos literais

## Introdução

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-00-01 | 5 | CONTEXTO | "desenvolvemos plataformas de cassino online com tecnologia de ponta: NestJS, Bun, TanStack, DDD e arquitetura orientada a eventos." |
| R-00-02 | 7 | CONTEXTO | "Ele foi desenhado para refletir problemas reais do nosso dia a dia: sistemas distribuídos, tempo real, precisão monetária, experiência de usuário e arquitetura bem pensada." |
| R-00-03 | 9 | CONTEXTO | "Não esperamos perfeição — esperamos raciocínio claro, código limpo e decisões justificadas. Mostre como você pensa e como você constrói." |

Nenhum deles cria obrigação nem vale pontos no §14. São as únicas menções do enunciado a TanStack, tempo real e experiência de usuário.

## §1 Visão geral

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-01-01 | 15 | OBRIG | "Construa um serviço financeiro distribuído que processe transações de apostas recebidas de múltiplos provedores de jogos." |
| R-01-02 | 17–24 | CONTEXTO | "A avaliação é centrada em:" correção financeira; concorrência entre múltiplas instâncias; idempotência persistente; consistência entre saldo materializado e ledger; processamento assíncrono e recuperação após falhas; clareza das decisões técnicas. |
| R-01-03 | 26 | OBRIG | "O sistema deve permanecer correto quando mensagens forem **duplicadas**, entregues **fora de ordem** ou processadas **simultaneamente**." |

## §2 Autenticação

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-02-01 | 32 | CONTEXTO | "**autenticação não vale pontos** na tabela de avaliação (seção 14) e não deve competir com correção financeira, concorrência e idempotência." |
| R-02-02 | 32 | ESCOLHA | "O desafio **não prescreve** um mecanismo — a escolha, o desenho e a implementação são de sua responsabilidade, e serão discutidos na apresentação." |
| R-02-03 | 34 | OBRIG (se implementar) | "Se você implementar, a expectativa é **integrar um Identity Provider externo**, não escrever autenticação artesanal. Nada de tabela própria de usuários com hash de senha." |
| R-02-04 | 36 | CONTEXTO | "**Keycloak** (mais comum no mercado, OIDC completo) e **Zitadel** (mais leve, API-first) são pontos de partida razoáveis; qualquer IdP equivalente serve." |
| R-02-05 | 38 | OBRIG (se não implementar) | "Se você optar por **não** implementar, isso é aceito: documente a decisão no `ARCHITECTURE.md`, descreva o desenho que adotaria e deixe o ponto de extensão explícito no código (por exemplo um `AuthGuard` no-op ou um `ProviderIdentityPort`)." |
| R-02-06 | 40 | OBRIG | "os endpoints de health ficam abertos" |
| R-02-07 | 40 | OBRIG | "mensagens vindas da fila são tratadas como canal interno confiável — mas a identidade do provedor contida na mensagem continua sujeita às mesmas validações de domínio." |

## §3 Domínio e falhas assumidas

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-03-00 | 46 | CONTEXTO | "Provedores enviam operações associadas a uma rodada:" |
| R-03-01 | 49 | CONTEXTO | "`BET → WIN \| LOSS \| REFUND \| ROLLBACK`" (diagrama; quem pode referenciar quem está em R-07-08) |
| R-03-02 | 52 | OBRIG | "A entrega é **at-least-once**. Portanto assuma que:" (os itens R-03-03..08 são o que deve ser assumido) |
| R-03-03 | 54 | OBRIG | "a mesma operação pode chegar várias vezes;" |
| R-03-04 | 55 | OBRIG | "uma operação dependente pode chegar antes da operação referenciada;" |
| R-03-05 | 56 | OBRIG | "várias instâncias podem tocar a mesma wallet ao mesmo tempo;" |
| R-03-06 | 57 | OBRIG | "o processo pode morrer antes ou depois do commit;" |
| R-03-07 | 58 | OBRIG | "eventos podem ser publicados mais de uma vez;" |
| R-03-08 | 59 | OBRIG | "PostgreSQL e SQS podem ficar temporariamente indisponíveis." |
| R-03-09 | 61 | OBRIG | "**Invariantes globais:** o sistema não pode duplicar créditos, duplicar débitos, perder eventos confirmados ou permitir saldo negativo." |

## §4 Stack

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-04-01 | 71 | OBRIG | "Runtime / package manager / test runner \| **Bun 1.x**" |
| R-04-02 | 72 | OBRIG | "Linguagem \| **TypeScript** em modo estrito" |
| R-04-03 | 73 | OBRIG | "Framework \| **NestJS**" |
| R-04-04 | 74 | OBRIG | "Banco \| **PostgreSQL**" |
| R-04-05 | 75 | OBRIG | "Mensageria \| **AWS SQS** via **LocalStack** ou **MiniStack**" |
| R-04-06 | 76 | OBRIG | "Orquestração local \| **Docker Compose**" |
| R-04-07 | 77 | OBRIG | "Migrations \| versionadas e reversíveis" |
| R-04-08 | 81–84 | ESCOLHA + OBRIG | "Use **uma** das opções:" "**MikroORM — preferencial** (Unit of Work e Identity Map explícitos, `EntityManager.transactional()`, `LockMode`);" "**TypeORM** — aceito." |
| R-04-09 | 86 | PROIB | "**Prisma e outros ORMs estão fora do escopo.**" |
| R-04-10 | 86 | OBRIG | "A escolha, o mapeamento do `Money` e a estratégia transacional adotada devem ser justificados em `ARCHITECTURE.md`." |

## §5 Restrições invioláveis

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-05-01 | 90 | PROIB | "Não usar `number`, `float` ou `double` para dinheiro." |
| R-05-02 | 91 | PROIB | "Não usar cache em memória como garantia de idempotência." |
| R-05-03 | 92 | PROIB | "Não confiar apenas em SQS FIFO para garantir consistência." |
| R-05-04 | 93 | PROIB | "Não publicar eventos antes do commit da transação financeira." |
| R-05-05 | 94 | PROIB | "Não sobrescrever nem excluir lançamentos do ledger." |
| R-05-06 | 95 | PROIB | "Não usar lock global compartilhado por todas as wallets." |
| R-05-07 | 96 | PROIB | "Não implementar saldo como `read → calculate → update` sem controle de concorrência." |
| R-05-08 | 97 | OBRIG | "A solução deve estar correta com **múltiplas instâncias** da aplicação." |
| R-05-09 | 98 | OBRIG | "As garantias de unicidade, imutabilidade e não-negatividade descritas na seção 6 devem ser aplicadas **no schema do banco**, não apenas em código de aplicação. O desenho do schema, das constraints e dos índices é parte do que está sendo avaliado." |

## §6 Modelo de domínio

### 6.0 Regra de modelagem

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-06-01 | 104 | ESCOLHA + OBRIG | "Nomes e assinaturas podem ser adaptados, desde que as garantias sejam preservadas." |
| R-06-02 | 108 | OBRIG | "Construtor `private` ou `protected` + **factories estáticas** (`create`, `from`, `rehydrate`);" |
| R-06-03 | 109 | OBRIG | "a reidratação a partir do banco usa a factory `rehydrate`, que **não** revalida regras de transição — apenas reconstrói estado já persistido." |
| R-06-04 | 111 | OBRIG | "Os blocos abaixo são **esqueletos de referência**: o que importa é que o estado seja encapsulado e as transições sejam explícitas." |

### 6.1 Money

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-06-10 | 115–145 | ESQUELETO | *(resumo; o bloco L115–145 vale)* `MoneyProps` como interface ("DTO — interface é adequada aqui"), com `amount: string` ("decimal string, ex.: \"25.00\"") e `currency: string` ("ISO-4217"). `class Money` com construtor `private` sobre `value: Decimal` e `currency`; `from`, `zero`, `add`, `subtract`, `negate`, `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`, `toJSON`, `toString`, `assertSameCurrency` (privado). |
| R-06-11 | 148 | OBRIG | "`Money` é **imutável**: toda operação retorna uma nova instância." |
| R-06-12 | 152 | OBRIG | "`amount` é **recebido e serializado como string decimal**, sempre com escala fixa de **2** casas;" |
| R-06-13 | 153 | OBRIG | "operações entre moedas diferentes lançam erro de domínio;" |
| R-06-14 | 154 | OBRIG | "entradas inválidas são rejeitadas: `NaN`, `Infinity`, notação científica, string vazia, mais de 2 casas decimais, valores negativos em contratos de entrada;" |
| R-06-15 | 155 | OBRIG | "o domínio **não** depende de tipos monetários do ORM nem de decorators do NestJS;" |
| R-06-16 | 156 | ESCOLHA + OBRIG | "na persistência, valor e moeda podem ocupar colunas separadas, desde que a representação seja exata e reidratada como `Money`." |
| R-06-17 | 158 | ESCOLHA + OBRIG | "Para reduzir escopo, **todo o desafio pode assumir uma única moeda (`BRL`)**, desde que o modelo continue multi-moeda e os conflitos de moeda sejam testados." |
| R-06-18 | 160–163 | CONTRATO | "Formato nos contratos:" `{ "amount": "25.00", "currency": "BRL" }` |

### 6.2 Wallet (Aggregate Root)

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-06-20 | 166–200 | ESQUELETO | *(resumo; o bloco L166–200 vale)* `class Wallet` (título: "Aggregate Root") com construtor `private` e campos `id`, `playerId`, `currency`, `_balance: Money`, `_version: number`, `createdAt`, `_updatedAt`; getters `balance`, `version`, `updatedAt`; `assertSameCurrency` (privado). |
| R-06-20a | 180–184 | ESQUELETO | *(resumo)* `static open(props: { id: string; playerId: string; initialBalance: Money; }): Wallet;` — não há campo `currency` próprio. |
| R-06-20b | 186–187 | ESQUELETO | "Reconstrução a partir da persistência — não revalida transições." `static rehydrate(state: WalletState): Wallet;` |
| R-06-21 | 193 | OBRIG | *(comentário no código, sobre `debit` e `credit`)* "Aplicam a movimentação mantendo saldo e ledger consistentes entre si." |
| R-06-21a | 194 | ESCOLHA | *(comentário no código)* "Assinatura e retorno são decisão sua." |
| R-06-22 | 204 | OBRIG | "no máximo **uma wallet por `playerId` + `currency`**;" |
| R-06-23 | 205 | OBRIG | "saldo nunca negativo;" |
| R-06-24 | 206 | OBRIG | "**toda alteração de saldo tem um lançamento correspondente no ledger** (e vice-versa);" |
| R-06-25 | 207 | OBRIG | "operações concorrentes não podem causar lost update;" |
| R-06-26 | 208 | OBRIG | "a moeda da operação deve ser igual à moeda da wallet;" |
| R-06-27 | 209 | OBRIG | "`version` inicia em `1` após a criação e **incrementa somente quando o saldo muda**." |
| R-06-28 | 211 | ESCOLHA + OBRIG | "`version` é sugerido para optimistic locking, mas outra estratégia é aceita se justificada." (A `version` em si é obrigatória pela R-06-27; o que pode mudar é usá-la para optimistic locking.) |

### 6.3 WagerTransaction

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-06-30 | 216–223 | ESQUELETO | *(resumo)* `WagerTransactionKind`: `OPENING` ("interno: crédito de abertura da wallet"), `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`. Os valores de string aparecem nos contratos (L486, L564). |
| R-06-31 | 225–231 | ESQUELETO | *(resumo)* `WagerTransactionStatus`: `PENDING` ("aceita, ainda não aplicada"), `PENDING_REFERENCE` ("aguardando a transação referenciada"), `PROCESSED` ("aplicada (terminal)"), `REJECTED` ("violação de regra de negócio (terminal)"), `FAILED` ("erro permanente de infraestrutura (terminal, auditável)"). `PROCESSED` aparece no contrato (L494). |
| R-06-32 | 233–253 | ESQUELETO | *(resumo)* Campos: `id`, `providerId`, `externalTransactionId`, `idempotencyKey`, `payloadHash`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`, `money`, `referenceExternalTransactionId: string \| undefined` ("id no provedor — não o id interno"), `createdAt`, `_status`, `_referenceTransactionId?`, `_failureCode?`, `_processedAt?`. |
| R-06-33 | 255–256 | OBRIG | "Nasce em PENDING. Valida a exigência de referência por kind." `static create(props: CreateWagerTransactionProps): WagerTransaction;` |
| R-06-33a | 257–262 | ESQUELETO | *(resumo)* `static rehydrate(state: WagerTransactionState)`; getters `status`, `referenceTransactionId`, `failureCode`, `processedAt`. |
| R-06-34 | 264–268 | ESQUELETO | "transições (lançam InvalidTransactionStateError se o estado atual for terminal)": `markProcessed(referenceTransactionId: string \| undefined, at: Date)`, `markPendingReference()`, `reject(code: FailureCode)`, `fail(code: FailureCode)`. |
| R-06-35 | 270–275 | ESQUELETO | "consultas de domínio": `isTerminal()`, `affectsBalance()` ("false para LOSS"), `requiresReference()` ("true para REFUND e ROLLBACK"), `matchesPayload(payloadHash)`, `ledgerDirectionFor(reference?)`. |
| R-06-36 | 279 | OBRIG | "`PROCESSED`, `REJECTED` e `FAILED` são **terminais**: uma transação que chegou a um deles não muda mais de estado, e tentar transicioná-la é erro de programação, não caminho de negócio." |
| R-06-37 | 279 | ESCOLHA + OBRIG | "Defina e documente as transições válidas." |
| R-06-38 | 281 | OBRIG | "`OPENING` é **interno**: não pode ser submetido pela API nem pela fila." |
| R-06-39 | 282 | OBRIG | "A mesma idempotency key com payload diferente é **conflito**, não replay." |

### 6.4 WalletLedgerEntry

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-06-40 | 286–306 | ESQUELETO | *(resumo)* `LedgerDirection { Debit = "DEBIT", Credit = "CREDIT" }`; `WalletLedgerEntry` com construtor `private` e campos `readonly` `id`, `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter`, `createdAt`; `create`, `rehydrate`, `isBalanced()` ("balanceBefore ± money === balanceAfter. Verificada na factory."). |
| R-06-41 | 309 | OBRIG | "**Sem campos mutáveis e sem métodos de transição** — a imutabilidade é estrutural, não uma convenção. `create` valida a aritmética do lançamento." |
| R-06-42 | 311 | OBRIG | "Uma transação financeira produz **no máximo um lançamento por wallet**." |
| R-06-43 | 312 | OBRIG | "Operações sem efeito no saldo (`LOSS`, e qualquer transação `REJECTED`) **não geram lançamento**." |
| R-06-44 | 313 | OPC | "Ledger de **partidas dobradas** (*double-entry bookkeeping*) é diferencial opcional, não requisito." |

### 6.5 Inbox e Outbox

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-06-50 | 318–334 | ESQUELETO | *(resumo)* `InboxMessage`: `messageId`, `consumerName`, `payloadHash`, `receivedAt`, `_processedAt?`; `receive`, `rehydrate`, `isProcessed()`, `markProcessed(at)`. |
| R-06-51 | 336–360 | ESQUELETO | *(resumo)* `OutboxMessage`: `id`, `aggregateId`, `eventType`, `payload: Readonly<Record<string, unknown>>`, `occurredAt`, `_attempts`, `_nextAttemptAt?`, `_publishedAt?`; `enqueue(event: IntegrationEvent<unknown>)`, `rehydrate`, `isPending()`, `isDue(now)`, `markPublished(at)`, `scheduleRetry(now)` ("incrementa attempts e calcula o próximo nextAttemptAt (backoff)"). |
| R-06-52 | 363 | OBRIG | "Inbox, alteração financeira, ledger e outbox participam da **mesma transação SQL**." |

## §7 Regras de negócio

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-07-01 | 371 | OBRIG | "`BET` \| débito \| 1 entrada `DEBIT` \| rejeitar se saldo insuficiente" |
| R-07-02 | 372 | OBRIG | "`WIN` \| crédito \| 1 entrada `CREDIT` \| pode referenciar a `BET` da mesma rodada" |
| R-07-03 | 373 | OBRIG | "`LOSS` \| nenhum \| nenhuma \| registra o resultado sem mover saldo" |
| R-07-04 | 374 | OBRIG | "`REFUND` \| crédito \| 1 entrada `CREDIT` \| reverte uma `BET` `PROCESSED`, uma única vez" |
| R-07-05 | 375 | OBRIG | "`ROLLBACK` \| inverso da referência \| 1 entrada invertida \| reverte uma transação `PROCESSED`, uma única vez" |
| R-07-06 | 379 | OBRIG | "`REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`." |
| R-07-07 | 380 | OBRIG | "A referência é resolvida por `(providerId, referenceExternalTransactionId)` e deve pertencer ao **mesmo provider, player, wallet, moeda e rodada**." |
| R-07-08 | 381 | OBRIG | "`REFUND` só referencia `BET`. `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`." |
| R-07-09 | 382 | OBRIG | "Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação." |
| R-07-10 | 383 | OBRIG | "O valor de `REFUND`/`ROLLBACK` deve ser **igual** ao valor da referência (reversão parcial está fora de escopo)." |
| R-07-11 | 384 | OBRIG | "Transação `REJECTED` não altera saldo nem gera ledger." |
| R-07-12 | 385 | OBRIG | "Repetir uma operação já processada retorna **o resultado original**, incluindo o saldo observado naquele momento." |
| R-07-13 | 386 | OBRIG | "Referência ausente → persistir como `PENDING_REFERENCE` e reprocessar depois (ver 7.1)." |
| R-07-14 | 387 | OBRIG | "Reversão que produziria saldo negativo é **rejeitada explicitamente**, com um `failureCode` distinto do de uma aposta sem saldo — são situações operacionalmente diferentes — e permanece auditável." |
| R-07-15 | 389 | OBRIG | "Qualquer interpretação adicional adotada deve ser documentada." |

### 7.1 Referências fora de ordem

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-07-20 | 393 | OBRIG | "Transações `PENDING_REFERENCE` são reprocessadas por um **worker agendado** com backoff exponencial." |
| R-07-21 | 394 | ESCOLHA + OBRIG | "Limite de tentativas ou TTL definido e justificado por você." |
| R-07-22 | 395 | OBRIG | "Esgotado o limite: `REJECTED` com um `failureCode` que identifique a referência inexistente, e evento correspondente publicado." |

### 7.2 Códigos de falha

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-07-30 | 399 | OBRIG | "Toda rejeição precisa carregar um `failureCode` estável e legível por máquina, suficiente para o provedor decidir se reenvia, corrige o payload ou desiste." |
| R-07-31 | 399 | ESCOLHA + OBRIG | "A taxonomia é sua — defina-a e documente-a." |

## §8 Concorrência e ordenação

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-08-01 | 405 | OBRIG | "A **unidade de concorrência é a `walletId`**." |
| R-08-02 | 407 | OBRIG | "A solução deve manter a correção quando:" (os itens R-08-03..06 são as situações) |
| R-08-03 | 409 | OBRIG | "duas apostas disputam o mesmo saldo;" |
| R-08-04 | 410 | OBRIG | "múltiplos workers recebem operações da mesma wallet;" |
| R-08-05 | 411 | OBRIG | "wallets diferentes são processadas em paralelo;" |
| R-08-06 | 412 | OBRIG | "**três ou mais instâncias** rodam simultaneamente." |
| R-08-07 | 414 | ESCOLHA + OBRIG | "A estratégia é sua escolha — pessimistic locking, optimistic locking com retry limitado, update atômico condicionado ou uma combinação — e deve ser justificada em `ARCHITECTURE.md`." |
| R-08-08 | 416 | OBRIG | "Recursos de ordenação e deduplicação do broker são **otimização**, não a garantia final: o banco continua responsável pelas invariantes." |
| R-08-09 | 418–428 | OBRIG | "Cenário obrigatório" — "Saldo inicial `100.00 BRL`. Duas apostas de `80.00 BRL` processadas simultaneamente." "Resultado esperado:" exatamente uma aposta `PROCESSED`; a outra `REJECTED` por saldo insuficiente; saldo final `20.00 BRL`; exatamente **um** lançamento de débito no ledger; nenhum retry duplica o débito. |

## §9 API HTTP

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-09-01 | 434 | CONTEXTO | "Autenticação dos endpoints abaixo: ver **seção 2**." |
| R-09-02 | 438–447 | CONTRATO | *(bloco L438–447 vale)* `POST /wallets` com `{ "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", "initialBalance": { "amount": "1000.00", "currency": "BRL" } }` |
| R-09-03 | 449 | OBRIG | "O saldo inicial, quando maior que zero, gera uma transação interna `OPENING` **na mesma transação SQL**, com lançamento `CREDIT` correspondente no ledger." |
| R-09-04 | 451–458 | CONTRATO | *(bloco L451–458 vale)* `{ "id": "0192f291-27dd-7d3f-8071-5f8685deef37", "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", "balance": { "amount": "1000.00", "currency": "BRL" }, "version": 1 }` |
| R-09-05 | 460 | OBRIG | "Criar wallet duplicada para o mesmo `playerId` + `currency` deve falhar como conflito." |
| R-09-06 | 465 | CONTRATO | `GET /wallets/:walletId` |
| R-09-07 | 466 | CONTRATO | `GET /wallets/:walletId/ledger?cursor=...&limit=50   # cursor estável e opaco` |
| R-09-08 | 467 | CONTRATO | `GET /wagering/transactions/:transactionId` |
| R-09-09 | 468 | CONTRATO | `GET /providers/:providerId/wagering/transactions/:externalTransactionId` |
| R-09-10 | 473–489 | CONTRATO | *(bloco L473–489 vale)* `POST /wagering/transactions`, header `Idempotency-Key: provider-a:transaction-123`, corpo `{ "providerId": "provider-a", "externalTransactionId": "transaction-123", "playerId": "0192f28f-…f4a1", "walletId": "0192f291-…ef37", "roundId": "round-987", "gameId": "fortune-chimp", "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" } }` |
| R-09-11 | 491–498 | CONTRATO | *(bloco L491–498 vale)* `{ "transactionId": "0192f298-345e-7e38-af88-e43f851a819d", "status": "PROCESSED", "balance": { "amount": "975.00", "currency": "BRL" }, "idempotentReplay": false }` |
| R-09-12 | 502 | OBRIG | "o header `Idempotency-Key` é obrigatório e é a fonte da verdade;" |
| R-09-13 | 503 | ESCOLHA | "default recomendado: `\"{providerId}:{externalTransactionId}\"`;" |
| R-09-14 | 504 | OBRIG | "`payloadHash` = hash de um **JSON canônico** (chaves ordenadas) do subconjunto de campos de negócio — o header e metadados de transporte não entram no hash. O algoritmo deve estar documentado;" |
| R-09-15 | 505 | OBRIG | "requisição idêntica → mesma resposta, `idempotentReplay: true`;" |
| R-09-16 | 506 | OBRIG | "mesma key com payload diferente → conflito, e **não** replay." |
| R-09-17 | 508 | ESCOLHA + OBRIG | "**Status HTTP:** o mapeamento é decisão sua, mas a API precisa distinguir com clareza — e de forma consistente entre todos os endpoints — payload inválido, conflito de idempotência, rejeição por regra de negócio, aceite com processamento pendente e falha transitória de infraestrutura. Colapsar essas situações em um mesmo código obriga o provedor a interpretar mensagem de erro para decidir se pode reenviar." |
| R-09-18 | 512–525 | CONTRATO | *(bloco L512–525 vale)* `POST /wallets/:walletId/reconciliation` → `{ "walletId", "storedBalance", "calculatedBalance", "difference", "consistent": true, "checkedEntries": 42 }`, com valores em `MoneyProps` |
| R-09-19 | 527 | OBRIG | "Divergências **não** são corrigidas silenciosamente: devem ser logadas, contabilizadas em métrica e sinalizadas na resposta." |
| R-09-20 | 532 | CONTRATO | `GET /health/live     # processo vivo` |
| R-09-21 | 533 | CONTRATO | `GET /health/ready    # PostgreSQL e SQS alcançáveis` |
| R-09-22 | 536 | OBRIG | "Os endpoints de health **não** devem exigir autenticação." |

## §10 Processamento por SQS

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-10-01 | 542–546 | CONTRATO | Filas: `wager-transactions.fifo` e `wager-transactions-dlq.fifo` |
| R-10-02 | 549–567 | CONTRATO | *(bloco L549–567 vale)* `{ "messageId": "msg-123", "type": "WagerTransactionRequested", "occurredAt": "2026-07-29T15:00:00.000Z", "data": { "providerId", "externalTransactionId", "idempotencyKey": "provider-a:transaction-123", "playerId", "walletId", "roundId", "gameId", "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" } } }` |
| R-10-03 | 572 | OBRIG | "reutilizar **o mesmo use case** da entrada HTTP;" |
| R-10-04 | 573 | OBRIG | "deduplicar via **inbox persistente** por `(consumerName, messageId)`;" |
| R-10-05 | 574 | OBRIG | "fazer `ack` **somente após o commit**;" |
| R-10-06 | 575 | OBRIG | "distinguir erros de **negócio** (terminal, ack), **transitórios** (retry com backoff) e **permanentes** (DLQ);" |
| R-10-07 | 576 | OBRIG | "respeitar um limite de tentativas antes da DLQ;" |
| R-10-08 | 577 | OBRIG | "em `SIGTERM`, concluir mensagens em andamento ou devolver a visibilidade;" |
| R-10-09 | 578 | OBRIG | "suportar redelivery sem duplicar efeitos." |

## §11 Transactional Outbox

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-11-01 | 584 | OBRIG | "A persistência da transação, a alteração de saldo, o lançamento no ledger, o registro de inbox (quando a entrada for SQS) e o evento de integração precisam ser **atômicos**: ou tudo é confirmado junto, ou nada é." |
| R-11-02 | 586 | OBRIG | "Um **worker** publica os eventos pendentes e precisa funcionar com múltiplos publishers concorrentes, sem perder nem duplicar indefinidamente." |
| R-11-03 | 588–594 | OBRIG | "Cenário que precisa funcionar:" o PostgreSQL confirma o commit; o processo morre antes de publicar; outra instância assume o trabalho; o evento é publicado; uma publicação duplicada continua segura para o consumidor. |
| R-11-04 | 600 | OBRIG | "`WagerTransactionProcessed` \| qualquer transação aplicada, inclusive `LOSS`" |
| R-11-05 | 601 | OBRIG | "`WagerTransactionRejected` \| transação rejeitada por regra de negócio" |
| R-11-06 | 602 | OBRIG | "`WalletBalanceChanged` \| **somente** quando o saldo muda" |
| R-11-07 | 603 | OBRIG | "`WagerTransactionPendingReference` \| referência ausente" |
| R-11-08 | 605 | OBRIG | "Envelope — **classe abstrata**, com uma subclasse concreta por evento:" |
| R-11-09 | 607–642 | CONTRATO | *(bloco L607–642 vale)* `IntegrationEventProps<T>` e `abstract class IntegrationEvent<T>` (`eventType` e `version` abstratos; construtor `protected`). `toJSON()` ("Envelope serializado gravado no payload da outbox.") → `{ eventId, eventType, aggregateId, correlationId, causationId?, occurredAt: string ("ISO-8601"), version: number, data: T }`. |
| R-11-10 | 644 | OBRIG | "Exemplo de subclasse — o `eventType` e a `version` ficam **no tipo**, não em uma string solta no call site:" |
| R-11-11 | 646–663 | EXEMPLO + CONTRATO | O bloco é apresentado como "Exemplo de subclasse", mas é o **único** `data` definido para um evento obrigatório (R-11-06). *(bloco L646–663 vale)* `WalletBalanceChangedData { walletId, transactionId, direction: LedgerDirection, money: MoneyProps, balanceBefore: MoneyProps, balanceAfter: MoneyProps, walletVersion: number }`; `class WalletBalanceChanged` com `eventType = "WalletBalanceChanged"`, `version = 1`, `static from(wallet, entry, ctx)`. |
| R-11-12 | 665 | OBRIG | "`data` carrega `MoneyProps` (string decimal), nunca a instância de `Money` — o payload precisa ser JSON estável e versionável." |

## §12 Observabilidade

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-12-01 | 673 | OBRIG | "**logs estruturados** (JSON) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`;" |
| R-12-02 | 674 | OBRIG | "**sem** dados sensíveis ou payloads financeiros completos nos logs;" |
| R-12-03 | 675 | OBRIG | "**métricas** cobrindo, no mínimo: transações por status, duplicatas detectadas, retries, mensagens em DLQ, conflitos de lock, outbox lag e latência de processamento;" |
| R-12-04 | 676 | OBRIG | "**health checks** separados para liveness e readiness." |
| R-12-05 | 678 | OPC | "OpenTelemetry e dashboard são opcionais." |

## §13 Testes obrigatórios

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-13-U1 | 686 | OBRIG | Unidade: "operações e validações de `Money` (escala, arredondamento, entradas inválidas);" |
| R-13-U2 | 687 | OBRIG | Unidade: "invariantes da `Wallet`;" |
| R-13-U3 | 688 | OBRIG | Unidade: "regras de `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`;" |
| R-13-U4 | 689 | OBRIG | Unidade: "conflito de moeda;" |
| R-13-U5 | 690 | OBRIG | Unidade: "idempotency key com payload divergente." |
| R-13-I0 | 692 | OBRIG | "Integração (PostgreSQL e LocalStack/MiniStack reais em containers)" |
| R-13-I1 | 694 | OBRIG | Integração: "migrations e constraints;" |
| R-13-I2 | 695 | OBRIG | Integração: "atomicidade entre wallet, ledger, inbox e outbox;" |
| R-13-I3 | 696 | OBRIG | Integração: "inbox e redelivery;" |
| R-13-I4 | 697 | OBRIG | Integração: "publishers concorrentes sobre a mesma outbox;" |
| R-13-I5 | 698 | OBRIG | Integração: "retry e DLQ;" |
| R-13-I6 | 699 | OBRIG | Integração: "recuperação após reinicialização." |
| R-13-C0 | 701 | OBRIG | "Concorrência (paralelismo real, não mocks sequenciais)" |
| R-13-C1 | 703 | OBRIG | "a mesma aposta enviada **50 vezes em paralelo** → um único débito;" |
| R-13-C2 | 704 | OBRIG | "operações concorrentes disputando o saldo da mesma wallet (cenário da seção 8);" |
| R-13-C3 | 705 | OBRIG | "wallets distintas processadas em paralelo;" |
| R-13-C4 | 706 | OBRIG | "**≥ 3 processos/instâncias** simultâneos;" |
| R-13-C5 | 707 | OBRIG | "worker morto **depois do commit e antes do ack**;" |
| R-13-C6 | 708 | OBRIG | "dois publishers sobre a mesma outbox;" |
| R-13-C7 | 709 | OBRIG | "`ROLLBACK` ou `REFUND` entregue antes da referência;" |
| R-13-C8 | 710 | OBRIG | "reinício do serviço com comprovação da consistência final." |
| R-13-INV | 712–716 | OBRIG | "**Invariante final de todos os testes:**" `wallet.balance == saldo reconstruído pelo ledger` |

## §14 Avaliação

| ID | Lx | Tipo | Texto |
|---|---|---|---|
| R-14-01 | 722–731 | OBRIG (critério de avaliação) | Alguns critérios só aparecem aqui: "hot wallet" (L725), "determinismo" (L729), "diagnóstico" (L730). "shutdown" (L727) é mais amplo que o `SIGTERM` do consumidor (L577). *(resumo da tabela)* Correção financeira 20 ("`Money`, saldo, ledger, reversões, reconciliação"); Concorrência 20 ("lost updates, hot wallet, múltiplas instâncias, locks"); Idempotência 15 ("dedup persistente, replay, payload conflitante"); Mensageria e falhas 15 ("inbox, outbox, retry, DLQ, crash recovery, shutdown"); Modelagem e arquitetura 10 ("invariantes encapsuladas em classes, boundaries, portas, simplicidade"); Testes 10 ("integração real, races, determinismo, cobertura de falhas"); Observabilidade 5 ("logs, métricas, health checks, diagnóstico"); Documentação 5. |
| R-14-02 | 731 | OBRIG | Documentação: "`README.md` com setup e comandos, `ARCHITECTURE.md` com decisões, trade-offs e limitações". Está na coluna "O que será observado", mas o `ARCHITECTURE.md` também é exigido nas L38, L86 e L414. |
| R-14-E1 | 735 | ELIM | "`number` para dinheiro;" |
| R-14-E2 | 736 | ELIM | "saldo negativo causado por race;" |
| R-14-E3 | 737 | ELIM | "débito ou crédito duplicado;" |
| R-14-E4 | 738 | ELIM | "idempotência apenas em memória;" |
| R-14-E5 | 739 | ELIM | "solução correta somente com uma instância;" |
| R-14-E6 | 740 | ELIM | "publicação de evento antes do commit;" |
| R-14-E7 | 741 | ELIM | "ausência de ledger auditável;" |
| R-14-E8 | 742 | ELIM | "testes que substituem completamente PostgreSQL e SQS por mocks." |
| R-14-O1 | 746 | OPC | "Teste de carga também conta como diferencial. Se fizer, exponha como `bun run test:load` e registre ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e outbox lag." |
| R-14-O2 | 746 | CONTEXTO | "Não há meta de RPS — a qualidade do experimento e a honestidade da análise pesam mais que o número bruto." |

## O que precisa ser documentado

**O enunciado diz que vai no `ARCHITECTURE.md`:**
- R-02-05 (L38): auth, se não implementar.
- R-04-10 (L86): ORM, mapeamento do `Money`, estratégia transacional.
- R-08-07 (L414): estratégia de concorrência.
- R-14-02 (L731): decisões, trade-offs e limitações.

**O enunciado pede para documentar ou justificar, mas não diz onde.** O local é decisão do passo 2.
- R-06-28 (L211): estratégia, se não for optimistic locking com `version`.
- R-06-37 (L279): transições válidas.
- R-07-15 (L389): interpretações adicionais.
- R-07-21 (L394): limite ou TTL das pendências.
- R-07-31 (L399): taxonomia de `failureCode`.
- R-09-14 (L504): algoritmo do `payloadHash`.
- R-14-O1 (L746): registro do teste de carga, se houver.

---

# Parte B — Pontos em aberto (entrada do passo 2)

Cada ponto aponta as linhas e os IDs de origem. Classificação:
- **ESCOLHA**: o enunciado manda o candidato decidir.
- **AMBÍGUO**: o texto permite mais de uma leitura.
- **SILÊNCIO**: o enunciado não fala nada, mas o código vai precisar de uma resposta.

Nenhum ponto tem resposta aqui.

## B1. Dinheiro
| # | Origem | Tipo | Pergunta |
|---|---|---|---|
| B1.1 | L152, L154 (R-06-12, R-06-14) | AMBÍGUO | O texto diz "sempre com escala fixa de 2 casas", mas a lista de rejeição cita só "mais de 2 casas". `"25"` e `"25.5"` são aceitos (e normalizados) ou rejeitados? |
| B1.2 | L686, L154 (R-13-U1, R-06-14) | AMBÍGUO | O teste pede "arredondamento", mas entrada com mais de 2 casas é rejeitada. Onde existe arredondamento no sistema? |
| B1.3 | L154, L449 | SILÊNCIO | Transação com valor `0.00` é válida? Só o `initialBalance` tem regra para zero ("quando maior que zero"). |
| B1.4 | L124, L156, L90 (R-06-10, R-06-16, R-05-01) | ESCOLHA | Representação interna do `Decimal` do esqueleto (lib decimal ou inteiro de centavos), tipo da coluna, limite máximo de valor e de saldo. |
| B1.5 | L119, L158 (R-06-17) | ESCOLHA | Moedas aceitas: só `BRL` com modelo multi-moeda, ou uma lista ISO-4217? Qual a segunda moeda usada nos testes de conflito (L689)? |
| B1.6 | L119, L152, L158 | AMBÍGUO | A escala é fixa em 2 casas, mas há moedas ISO-4217 com 0 ou 3 casas (JPY, KWD). O sistema aceita só moedas de 2 casas, ou a escala passa a depender da moeda? |
| B1.7 | L133, L137, L154, L521 | AMBÍGUO | O esqueleto tem `negate()` e `isNegative()`, e a L154 proíbe negativos só "em contratos de entrada". A rejeição fica no `Money.from` ou na borda do sistema? Qual o sinal do `difference` da reconciliação, que é saída e pode ser negativo? |

## B2. Idempotência
| # | Origem | Tipo | Pergunta |
|---|---|---|---|
| B2.1 | L502, L503 | ESCOLHA | Escopo da unicidade da key: global ou por `providerId`? |
| B2.2 | L502, L380, L468 | AMBÍGUO | Mesmo `(providerId, externalTransactionId)` com outra key: é conflito, replay ou uma transação nova? A L380 resolve referências e a L468 consulta transações por esse par; o texto não diz se ele é único. |
| B2.3 | L504, L559 | ESCOLHA | Quais campos de negócio entram no `payloadHash`, qual o algoritmo e qual normalização acontece antes do hash. No HTTP, a key vem do header, e a L504 exclui o header do hash. Na fila, a key vem em `data.idempotencyKey`: ela entra no hash? |
| B2.4 | L505, L385 | AMBÍGUO | "Mesma resposta" no replay inclui o status HTTP? Vale também para `REJECTED`? E para uma transação que estava `PENDING_REFERENCE` e depois foi resolvida: o replay devolve o resultado original ou o estado atual? |
| B2.5 | L573, L322, L506 | SILÊNCIO | Mesmo `messageId` com conteúdo diferente: o que fazer? Mensagens com `messageId` diferente e mesma key: o replay acontece no use case? |
| B2.6 | L559, L502 | SILÊNCIO | Na fila, se `data.idempotencyKey` faltar, é erro de negócio (ack) ou permanente (DLQ)? |
| B2.7 | L553, L573 | AMBÍGUO | A inbox deduplica pelo `messageId` do corpo da mensagem ou pelo `MessageId` nativo do SQS? |
| B2.8 | L385, L495, L373, L384, L233–253 | SILÊNCIO | De onde vem o "saldo observado naquele momento" no replay? Para transações com lançamento, há o `balanceAfter`. `LOSS` e `REJECTED` não têm lançamento, e o esqueleto não tem campo de saldo. Onde esse valor é persistido (coluna na transação, resposta armazenada)? |
| B2.9 | L505, L508, L703 | SILÊNCIO | Duplicata que chega enquanto a original ainda está em andamento (como pode acontecer no teste das 50 em paralelo, L703): o sistema espera e devolve replay, ou responde "em processamento"? Se responder, em qual das 5 categorias da L508 cai? |

## B3. Regras de negócio e referências
| # | Origem | Tipo | Pergunta |
|---|---|---|---|
| B3.1 | L374, L375, L382 | AMBÍGUO | A tabela diz "uma única vez", e a regra 4 diz "pelo mesmo tipo de operação". Uma `BET` pode receber um `REFUND` e também um `ROLLBACK`? |
| B3.2 | L372 | AMBÍGUO | "pode referenciar a `BET`": a referência no `WIN` é opcional ou é obrigatória quando existe uma `BET`? Se vier e não existir, vira `PENDING_REFERENCE`? Se vier, valem as validações da L380? `LOSS` pode ter referência? |
| B3.3 | L374, L375, L386 | SILÊNCIO | E se a referência existir mas não estiver `PROCESSED` (`REJECTED`, `PENDING_REFERENCE`, `FAILED`)? |
| B3.4 | L375, L381, L382 | AMBÍGUO | Qual o efeito no saldo de um `ROLLBACK` de `REFUND` ("inverso da referência")? Depois dele, a `BET` original pode receber outro `REFUND`? |
| B3.5 | L399 (R-07-31) | ESCOLHA | Taxonomia completa de `failureCode`: cada violação de regra (saldo, referência, provider, player, wallet, moeda, rodada, valor, tipo, reversão duplicada, referência expirada), com granularidade e significado para o provedor (reenvia, corrige ou desiste). |
| B3.6 | L46, L49, L372, L373 | SILÊNCIO | Pode haver várias `BET`s na mesma rodada? Um `WIN` ou `LOSS` sem `BET` anterior na rodada é aceito? |
| B3.7 | L226, L255, L508 | AMBÍGUO | Quando o status `PENDING` é observável de fora? A L508 cita "aceite com processamento pendente": isso se refere a `PENDING`, a `PENDING_REFERENCE` ou a ambos? |
| B3.8 | L230, L575 | AMBÍGUO | Quando uma transação vira `FAILED`, e quem grava? Qual a relação de `FAILED` com uma mensagem que vai para a DLQ? |
| B3.9 | L393–395 | ESCOLHA | Limite de tentativas ou TTL, curva do backoff, e qual é o "evento correspondente" quando o limite esgota. |
| B3.10 | L386, L393 | SILÊNCIO | Quando a referência chega, a pendente é resolvida só pelo worker ou também de imediato? |
| B3.11 | L279 (R-06-37) | ESCOLHA | Tabela de transições válidas. Exemplos: `PENDING_REFERENCE → FAILED` é permitido? `markPendingReference()` pode ser chamado de novo a cada tentativa do worker? |
| B3.12 | L382 | SILÊNCIO | O que conta como "já revertida"? Uma reversão `REJECTED` ou `PENDING_REFERENCE` impede outra? |
| B3.13 | L603, L393 | SILÊNCIO | `WagerTransactionPendingReference` é emitido uma vez ou a cada tentativa do worker? |
| B3.14 | L372, L373, L382 | SILÊNCIO | A L382 limita só as reversões. Dois `WIN` podem referenciar a mesma `BET`? Um `WIN` e um `LOSS` para a mesma `BET`? Um `REFUND` de uma `BET` que já foi liquidada por `WIN` ou `LOSS`? |
| B3.15 | L217, L233–253, L449 | SILÊNCIO | A transação `OPENING` não tem `providerId`, `externalTransactionId`, `idempotencyKey`, `payloadHash`, `roundId` nem `gameId`. Colunas anuláveis com `CHECK` por kind, valores sintéticos ou tabela separada? Isso afeta os `NOT NULL` e as unicidades (L98). A `OPENING` aparece na consulta da L468? |

## B4. Wallet
| # | Origem | Tipo | Pergunta |
|---|---|---|---|
| B4.1 | L209, L449, L456 | AMBÍGUO | A criação com `OPENING` resulta em `version: 1`. O crédito de `OPENING` conta como "saldo muda" para a versão? E gera `WagerTransactionProcessed` e `WalletBalanceChanged`? |
| B4.2 | L438–447, L460 | SILÊNCIO | `POST /wallets` não tem `Idempotency-Key`. Como o cliente distingue um retry da própria criação de uma duplicata real? |
| B4.3 | L444 | SILÊNCIO | `playerId` precisa existir em algum lugar, ou basta um formato válido? |
| B4.4 | L166, L193–196, L206 (R-06-20, R-06-21, R-06-24) | ESCOLHA | Fronteira do agregado: `WagerTransaction` e `WalletLedgerEntry` ficam dentro ou fora do agregado `Wallet`? Assinatura e retorno de `debit`/`credit`. |
| B4.5 | L180–184 | SILÊNCIO | `Wallet.open` recebe `id`: quem gera os ids (domínio, aplicação, banco) e em que formato? |
| B4.6 | L466 | ESCOLHA | Formato do cursor do ledger, limite máximo e ordenação. |
| B4.7 | L513–527, L715 | AMBÍGUO | Reconciliação: o `calculatedBalance` é a soma dos lançamentos ou o último `balanceAfter`? A continuidade entre lançamentos é verificada? O que `checkedEntries` conta? Qual o status HTTP quando `consistent: false`? É um `POST` que só lê, ou que grava o resultado? |
| B4.8 | L442–449 | SILÊNCIO | `initialBalance` é obrigatório? |
| B4.9 | L527 | AMBÍGUO | "Não são corrigidas silenciosamente": existe correção explícita (por exemplo, um lançamento de ajuste, o que exigiria um kind novo) ou não existe correção nenhuma? |

## B5. Concorrência, persistência e processos
| # | Origem | Tipo | Pergunta |
|---|---|---|---|
| B5.1 | L414, L211 (R-08-07, R-06-28) | ESCOLHA | Estratégia: lock pessimista, otimista com retry limitado, update condicionado ou combinação. Papel da `version`. |
| B5.2 | L412, L706 | ESCOLHA | Topologia: quantos processos e de que tipos (API, consumidor, publisher, worker), e como o teste C4 sobe as instâncias. |
| B5.3 | L98 (R-05-09) | AMBÍGUO | O que entra em "unicidade, imutabilidade e não-negatividade descritas na seção 6"? A imutabilidade cobre só o ledger (L309) ou também os estados terminais (L279)? A não-negatividade cobre só o saldo (L205) ou também os valores (L154)? A unicidade inclui a idempotency key (L282)? As L382 e L573, que estão fora do §6, entram? E o que vai para o banco além disso? |
| B5.4 | L81–86 (R-04-08, R-04-10) | ESCOLHA | ORM (MikroORM ou TypeORM), mapeamento do `Money` e estratégia transacional. |

## B6. Mensageria
| # | Origem | Tipo | Pergunta |
|---|---|---|---|
| B6.1 | L586 | SILÊNCIO | Para onde os eventos da outbox são publicados (fila, tópico)? |
| B6.2 | L545–567, L92 | SILÊNCIO | Quem produz mensagens na fila FIFO? Qual `MessageGroupId` e qual deduplicação o produtor usa? O que o sistema aceita? |
| B6.3 | L575, L576 | ESCOLHA | Classificação de cada erro em negócio, transitório ou permanente; limite de tentativas e como contá-las; backoff. |
| B6.4 | L281, L40, L551–567 | AMBÍGUO | Mensagem malformada, com `type` desconhecido ou com `kind: OPENING`: ack como negócio ou DLQ como permanente? Quais "validações de domínio" da identidade do provedor valem na fila? |
| B6.5 | L577 | ESCOLHA | No `SIGTERM` do consumidor: concluir as mensagens em andamento ou devolver a visibilidade? Prazos. |
| B6.6 | L577, L727 | SILÊNCIO | O `SIGTERM` só é especificado para o consumidor. E para o publisher, o worker de pendências e a API? |
| B6.7 | L609–612 | SILÊNCIO | De onde vêm `correlationId` e `causationId` (HTTP, mensagem SQS, worker)? |
| B6.8 | L598–603, L610, L647–655 | SILÊNCIO | Só o `WalletBalanceChanged` tem `data` definido (R-11-11). Qual o `data` dos outros eventos? Qual o `aggregateId` de cada um? |
| B6.9 | L596 | SILÊNCIO | A lista de eventos é "mínima": existem outros eventos (abertura de wallet, `FAILED`)? |
| B6.10 | L594, L708 | SILÊNCIO | Quem é "o consumidor" dos eventos publicados, e como se demonstra que a publicação duplicada é segura para ele? |
| B6.11 | L586, L356–359 | ESCOLHA | Mecânica do publisher: claim, backoff, limite de tentativas e destino de uma mensagem da outbox que nunca publica. |
| B6.12 | L586, L654, L708 | SILÊNCIO | Com publishers concorrentes, os eventos da mesma wallet precisam sair em ordem? O `walletVersion` sugere que o consumidor ordena pela versão, mas o texto não afirma. Isso muda o claim da outbox (por linha ou por agregado) e, se o destino for FIFO, o `MessageGroupId`. |

## B7. HTTP e contratos
| # | Origem | Tipo | Pergunta |
|---|---|---|---|
| B7.1 | L508 | ESCOLHA | Tabela de status HTTP para as 5 categorias da L508, mais criação de wallet, recurso inexistente e, se houver auth, não autenticado e não autorizado. |
| B7.2 | L508, L384, L399, L601 | AMBÍGUO | Fronteira entre "payload inválido" e "rejeição por regra de negócio" (que vira `REJECTED`, L384, com `failureCode`, L399, e evento, L601). O payload inválido é persistido? Casos: moeda diferente da wallet (L153, L208); wallet inexistente; `OPENING` enviado por HTTP (L281); `REFUND` sem referência, já validado no `create` (L255, L379); wallet que não pertence ao `playerId` do corpo (L482–483, L560–561). |
| B7.3 | L379, L479–488, L556–566 | SILÊNCIO | Nenhum contrato mostra o campo `referenceExternalTransactionId`. Qual o nome e a posição dele no corpo HTTP e no `data` da mensagem? |
| B7.4 | L491–498 | SILÊNCIO | Só existe a resposta de `PROCESSED`. Como são as respostas de `REJECTED` (inclui o `failureCode`?), `PENDING_REFERENCE` e `LOSS`? |
| B7.5 | L465–468 | SILÊNCIO | Formato das respostas dos GETs: página do ledger e próximo cursor, representação da transação. |
| B7.6 | L467, L468 | SILÊNCIO | Quem pode consultar o quê (escopo por provedor, se houver auth)? |
| B7.7 | L59, L508 | ESCOLHA | Resposta e timeouts quando o PostgreSQL ou o SQS estão fora. |

## B8. Autenticação
| # | Origem | Tipo | Pergunta |
|---|---|---|---|
| B8.1 | L32–38 | ESCOLHA | Implementar (Keycloak, Zitadel ou equivalente) ou documentar e deixar o ponto de extensão? |
| B8.2 | L40, L478–481 | SILÊNCIO | Se implementar: a identidade do token tem que bater com o `providerId` do corpo? Quem pode criar wallets? |

## B9. Observabilidade, testes e documentação
| # | Origem | Tipo | Pergunta |
|---|---|---|---|
| B9.1 | L673–675 | ESCOLHA | Bibliotecas, formato de exposição das métricas e nomes delas. |
| B9.2 | L674 | AMBÍGUO | O que são "dados sensíveis" e "payloads financeiros completos"? Pode logar `amount`? `playerId`? |
| B9.3 | L678, L746 | ESCOLHA | Itens opcionais: OpenTelemetry, dashboard e teste de carga entram ou não? |
| B9.4 | L712–716 | AMBÍGUO | O "invariante final de todos os testes" vale também para os testes de unidade, que não têm banco? |
| B9.5 | L211, L279, L389, L394, L399, L504, L746 | ESCOLHA | Onde ficam os itens que o enunciado manda documentar sem dizer onde (`ARCHITECTURE.md`, README, outro arquivo)? |

---

# Parte C — A vaga (não é o enunciado)

Fonte: descrição da vaga colada por você. Não cria exigência do desafio e não tem linha no `CHALLENGE.md`. Serve só para escolher **quais extras** valem a pena.

| ID | Texto |
|---|---|
| V-01 | "NestJS, TypeScript, MikroORM, PostgreSQL, Docker, DDD e microsserviços, expondo REST APIs e comunicação em tempo real por WebSockets." |
| V-02 | "O ambiente também utiliza AWS — SQS, SNS, S3 e Secrets Manager —, Git e ferramentas de IA agêntica." |
| V-03 | "Implementar endpoints REST e fluxos com WebSockets em NestJS e TypeScript" |
| V-04 | "Evoluir modelos, consultas e migrações com MikroORM e PostgreSQL" |
| V-05 | "Contribuir com microsserviços e fluxos assíncronos usando SQS e SNS" |
| V-06 | "Conteinerizar serviços com Docker e investigar logs e erros de execução" |
| V-07 | "Usar S3 e Secrets Manager com orientação e práticas seguras" |
| V-08 | "Trabalhar com Git, revisar mudanças e validar criticamente conteúdo gerado por IA" |
| V-09 | "Você consegue acompanhar uma requisição pela API, domínio e banco de dados, escrever ou atualizar os testes relevantes, explicar o que mudou" |
| V-10 | Diferenciais: "Conhecimento de Terraform", "Conhecimento de Kubernetes", "Conhecimento de tecnologias Web3" |
| V-11 | "inclua um GitHub ou links para projetos que mostrem como você estrutura e explica seu código." |

## Perguntas da vaga que afetam o núcleo

São perguntas de projeto, não do enunciado. Entram no passo 2 porque a resposta muda o núcleo.

| # | Origem | Pergunta |
|---|---|---|
| C1 | R-06-44 | Partidas dobradas (opcional no enunciado): entra? Na mesma transação ou consumindo eventos? |
| C2 | V-02, V-05, B6.1 | O destino dos eventos (B6.1) pode ser um tópico SNS? |
| C3 | V-01, V-05 | "Microsserviços": processos separados de um mesmo serviço bastam, ou algum contexto vira serviço próprio? |
| C4 | V-07 | Secrets Manager: as credenciais são lidas de lá desde o início, ou entra depois? |
| C5 | V-01, V-03 | WebSocket: quais eventos vão para o cliente, e a partir de qual fonte? |
