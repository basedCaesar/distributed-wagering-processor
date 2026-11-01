# 02 — Decisões

Resolve a Parte B e a Parte C de `01-requisitos.md`. Cada ponto cita as perguntas que fecha. Formato: **decisão**, **por quê**, **alternativa descartada**.

Critérios, em ordem:
1. respeitar todos os trechos do enunciado ao mesmo tempo;
2. não abrir brecha para dinheiro duplicado ou perdido;
3. a garantia fica no banco, não só no código (§5.9);
4. não inventar regra que o enunciado não pede;
5. preferir a opção mais simples entre as corretas.

**Status:** todas aprovadas em 28/10/2026. As três escolhas de gosto (2.1, 9.2, 12.1) ficaram com a opção recomendada. D13 aprovada em 30/10/2026, junto com o ajuste da D11.5 (detalhe de cada parte no README dela). D14 aprovada em 30/10/2026. D15 aprovada em 30/10/2026, junto com a criação dos papéis do banco no init do Postgres (as migrations só dão os `GRANT`s). D15.9 e o ajuste da D15.5 (trigger de `INSERT` do `FAILED`) aprovados em 30/10/2026, na correção da revisão da S2. D15.10 e D16 aprovadas em 31/10/2026, no plano da S3 (16.4 com `500` para o `PROCESSING_FAILED`). D16.9–16.16 aprovadas em 31/10/2026, na correção da revisão da S3. D17 aprovada em 31/10/2026, no plano da S4. D17.6 e D17.7 aprovadas em 01/11/2026, na correção da revisão da S4 (D1.7 fica para a S9). D18 aprovada em 01/11/2026, no plano da S5. D18.10–18.13 aprovadas em 01/11/2026, na correção da revisão da S5.

---

## D1 — Reversões e liquidações
B3.1, B3.2, B3.3, B3.4, B3.6, B3.12, B3.14

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 1.1 | Uma transação é revertida **no máximo uma vez, por qualquer tipo**. | Satisfaz a tabela ("uma única vez") e a regra 4 ao mesmo tempo. `REFUND` + `ROLLBACK` da mesma `BET` creditaria duas vezes. | Uma por tipo: permite crédito duplicado. |
| 1.2 | `ROLLBACK` de `REFUND` debita. Sem saldo, `REJECTED` com o código de reversão sem saldo (L387). Depois disso, a `BET` não pode ser revertida de novo. | "Inverso da referência". Consequência de 1.1. Cadeia máxima: `BET ← REFUND ← ROLLBACK`. | "Estado líquido" (reverter de novo depois de desfeita): não cabe num índice único. Limitação documentada. |
| 1.3 | Só uma reversão `PROCESSED` bloqueia outra. Se duas reversões esperam a mesma referência, a primeira aplicada vence. | `REJECTED` não altera saldo (L384), então não reverteu nada. Um reenvio depois de "sem saldo" precisa funcionar. | Qualquer status bloqueia: trava a `BET` para sempre. |
| 1.4 | Vale para **toda** transação com referência (reversões, `WIN`, `LOSS`). Se a referência está `PENDING_REFERENCE`, a transação espera. Se está `REJECTED` ou `FAILED`, a transação é `REJECTED` na hora, com `REFERENCE_NOT_PROCESSED`. | Terminal nunca vira `PROCESSED`, então esperar é inútil, e o código diz ao provedor "desista" (L399). Para o `WIN`, evita pagar ganho de uma aposta que nunca debitou (por exemplo, `BET` rejeitada por falta de saldo): isso criaria dinheiro. | Tratar como "ausente" e esperar: código errado e atraso. Aceitar `WIN` de `BET` rejeitada: cria dinheiro. |
| 1.5 | Referência obrigatória em `REFUND`/`ROLLBACK`, opcional em `WIN`/`LOSS` (aponta para uma `BET`), proibida na `BET`. Quando vem: validações da L380; ausente → `PENDING_REFERENCE`. | L372 "pode"; L380 e L386 falam de referência em geral. | `WIN` obrigatório (contradiz "pode"); ignorar o campo (erro silencioso). |
| 1.6 | Sem estado de rodada. Várias `BET`s por rodada, `WIN`/`LOSS` sem `BET`, vários `WIN`s e `REFUND` depois de `WIN` são permitidos e documentados (L389). | O enunciado só limita reversões. Regras de liquidação dependeriam da ordem de chegada, que o §3 diz não ser confiável. | Uma liquidação por `BET`, máquina de estados da rodada. |
| 1.7 | Métrica e log `refund_after_settlement` quando um `REFUND` atinge uma `BET` já liquidada. Não bloqueia. | O caso suspeito fica visível ("diagnóstico", §14) sem inventar regra. | — |

---

## D2 — Dinheiro
B1.1–B1.7

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 2.1 | **Entrada:** `amount` com 0, 1 ou 2 casas (`^(0\|[1-9]\d*)(\.\d{1,2})?$`, até 12 dígitos inteiros), **normalizado para 2 casas** antes de tudo, inclusive do hash. `"25"` e `"25.00"` são a mesma operação. Saída sempre com 2 casas. | A lista de rejeição (L154) cita só "mais de 2 casas", e aceitar `"25"` não abre risco algum. | **Estrita** (só exatamente 2 casas): leitura literal da L152 ("recebido… com escala fixa de 2 casas"). Também defensável. |
| 2.2 | Rejeitados: vazio, sinal, notação científica, `NaN`, `Infinity`, zeros à esquerda, espaços, mais de 2 casas. Nada é arredondado. O teste de "arredondamento" (L686) prova que **não existe arredondamento**: 3 casas é rejeitado e `0.10 + 0.20 = 0.30` exato. | Arredondar dinheiro de entrada é perder ou criar centavos. | Arredondar para 2 casas: altera o valor que o provedor mandou. |
| 2.3 | Valor **> 0** em `BET`, `WIN`, `REFUND` e `ROLLBACK`. Valor **≥ 0** em `LOSS`. `initialBalance` ≥ 0; zero não gera `OPENING` (L449). | Um crédito de 0 geraria um lançamento sem mudança de saldo, contradizendo "version só muda quando o saldo muda" (L209). `LOSS` não move dinheiro, e provedores mandam 0. | Aceitar 0 em tudo; rejeitar 0 no `LOSS`. |
| 2.4 | `Money` guarda **centavos em `bigint`** do JavaScript, com a moeda. No banco, `numeric(20,2)` e `char(3)`, lidos como string e convertidos sem passar por `number`. Saldo máximo: 15 dígitos inteiros; acima disso, `REJECTED` com `BALANCE_LIMIT_EXCEEDED`. | Exato e nativo, sem dependência. O domínio só soma e subtrai. `numeric` é o padrão para dinheiro em SQL e fica legível na auditoria. | `decimal.js` (dependência para algo que `bigint` resolve); coluna `bigint` de centavos (ilegível em SQL). |
| 2.5 | Moedas aceitas: lista configurável, padrão `BRL` e `USD`, só moedas de 2 casas. Moeda fora da lista é payload inválido. `USD` é a segunda moeda dos testes de conflito. | A escala fixa de 2 casas (L152) é incompatível com JPY/KWD. O modelo continua multi-moeda (L158). | Lista ISO completa com escala por moeda: contradiz a L152. |
| 2.6 | `Money` pode ser negativo internamente (`negate`, `subtract`, `difference`). A proibição de negativo fica na **fábrica de entrada** (`Money.from`), usada pelos contratos. A reconstrução interna usa outra fábrica. `difference` da reconciliação = armazenado − calculado, com sinal (`"-5.00"`). | A L154 proíbe negativo "em contratos de entrada", não no tipo. | Proibir negativo no tipo: impede `negate()` e a diferença da reconciliação. |

---

## D3 — Idempotência
B2.1–B2.9

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 3.1 | `UNIQUE (provider_id, idempotency_key)`. | Quem gera a key é o provedor. Dois provedores podem gerar `tx-1` sem que isso seja duplicata. | Unicidade global: conflito falso entre provedores. |
| 3.2 | `UNIQUE (provider_id, external_transaction_id)` também. Mesmo id externo com outra key → `409 EXTERNAL_ID_CONFLICT`. | A referência (L380) e a consulta (L468) só funcionam se o par apontar para uma transação só. | Tratar como replay: ignora a key, que é "a fonte da verdade". |
| 3.3 | `payloadHash` = SHA-256 (hex) do JSON canônico (chaves ordenadas, sem espaços) com os campos `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (normalizado) e `referenceExternalTransactionId` (omitido se ausente). Ficam de fora a key, o `messageId`, o `type` e o `occurredAt`. | É o mesmo hash no HTTP e na fila, então um reenvio pelo outro canal é replay (mesmo use case, L572). A key é a identidade, não o conteúdo. | Incluir a key ou metadados: HTTP e fila gerariam hashes diferentes para a mesma operação. |
| 3.4 | **Replay** devolve o estado atual da transação, com `idempotentReplay: true` e o status HTTP desse estado. Estados terminais nunca mudam, então para eles a resposta (inclusive o status HTTP) é sempre a original. Uma transação que estava pendente (`202`) e foi resolvida devolve o resultado novo (`200` ou `422`). | Atende "mesma resposta" (L505) e "resultado original" (L385). | Guardar a resposta HTTP inteira: duplica dados que já estão na linha. |
| 3.5 | O saldo observado fica numa coluna `balance_after` da transação. É o saldo depois de aplicar ou, no `REJECTED`/`LOSS`, o saldo no momento da decisão. Fica nulo enquanto está pendente. | `LOSS` e `REJECTED` não têm lançamento, e a L385 exige o saldo. | Ler do ledger: não existe para `LOSS`/`REJECTED`. |
| 3.6 | **Duplicata simultânea:** o use case trava a wallet primeiro e só então faz a checagem autoritativa de idempotência. A duplicata espera o lock, vê a original já commitada e devolve replay. Nas 50 em paralelo: 1 débito e 49 replays, todos `200`. Antes do lock há uma checagem rápida, só de leitura, para replays de operações já antigas. | Nenhuma categoria nova de resposta. O índice único é a barreira final (por exemplo, a mesma key enviada para duas wallets ao mesmo tempo, que travam locks diferentes): se for violado, o use case repete uma vez e cai no replay ou no conflito `409`. | Responder "em processamento" (`409`): obriga o provedor a reenviar e cria uma categoria a mais. |
| 3.7 | Inbox por `(consumer_name, messageId do corpo)`. | O campo do §10 se chama `messageId`. O `MessageId` nativo do SQS muda a cada envio e não deduplicaria um reenvio. | `MessageId` do SQS. |
| 3.8 | O hash da inbox é o `payloadHash` da 3.3 mais o `type`, então um reenvio do produtor com outro `occurredAt` continua sendo a mesma mensagem. Mesmo `messageId` com hash diferente → DLQ (permanente). `messageId` diferente com a mesma key → passa pela inbox e o use case devolve replay. `idempotencyKey` faltando na mensagem → inválida → DLQ. | Conflito de `messageId` é bug do produtor, e a DLQ guarda a evidência. A segunda barreira (a key) impede efeito duplicado. | Ack do conflito: perde a evidência. |

---

## D4 — Ciclo de vida da transação
B3.7–B3.11, B3.13

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 4.1 | Processamento **síncrono**. A transação nasce `PENDING` em memória (L255) e é decidida na mesma transação SQL: `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`. `PENDING` nunca fica gravado. "Aceite com processamento pendente" (L508) = `PENDING_REFERENCE`. | O exemplo do §9 devolve `PROCESSED` com saldo na hora. | Aceite assíncrono (sempre `202`): perde a resposta imediata do §9. |
| 4.2 | `FAILED` só para uma pendente que o worker não consegue processar por erro **não** de negócio e não transitório (bug, dado corrompido), depois de 5 erros seguidos. Gravado só pelo worker. Uma mensagem que vai para a DLQ **não** cria transação: a transação foi desfeita, e a mensagem na DLQ é o registro. | O enunciado define `FAILED` como "erro permanente de infraestrutura, terminal, auditável". Só uma transação já gravada pode virar `FAILED`. | Nunca usar `FAILED`; gravar `FAILED` no consumidor (exigiria gravar fora da transação desfeita). |
| 4.3 | Worker agendado: a cada 1 s pega as pendentes vencidas com `SKIP LOCKED`, numa transação curta que marca um lease. Depois processa cada uma pelo mesmo caminho (trava a wallet e relê). Backoff exponencial de 1 s, dobrando até 60 s. **Prazo: 15 minutos** desde a criação. Esgotado: `REJECTED` com `REFERENCE_NOT_FOUND` ("a referência não ficou disponível no prazo": ausente ou ainda pendente) e evento `WagerTransactionRejected`. | 15 min cobre a janela de reenvio do consumidor (D8) com folga. Se a referência estiver presa em retry na fila, ainda chega a tempo. | Contar tentativas: o prazo real ficaria dependente do backoff. Prazos curtos: expiram antes do reenvio da fila. |
| 4.4 | Quando uma transação chega a um estado terminal, o use case "cutuca" as pendentes **da mesma wallet** que a referenciam: põe o `next_attempt_at` delas em agora, na mesma transação, pulando linhas travadas (`SKIP LOCKED`). O worker as resolve em cerca de 1 s. Pendentes de outra wallet seriam rejeitadas por escopo de qualquer forma, então não precisam do atalho. | Latência baixa sem processar uma cascata dentro da transação. Ordem de locks sempre wallet → pendentes da própria wallet, e o `SKIP LOCKED` evita esperas: sem deadlock. | Resolver na hora, em cascata: mais locks e mais código. Só o worker: até 60 s de atraso. |
| 4.5 | Transições: `PENDING → PROCESSED \| REJECTED \| PENDING_REFERENCE`; `PENDING_REFERENCE → PROCESSED \| REJECTED \| FAILED`; terminais não mudam (L279). As tentativas do worker são colunas de controle, fora da entidade. | Explícitas e documentadas (L279). | — |
| 4.6 | `WagerTransactionPendingReference` é emitido **uma vez**, ao entrar no estado. | Evento sinaliza mudança de estado. As tentativas aparecem nas métricas de retry. | Um evento por tentativa: ruído. |

---

## D5 — Inválido × rejeição, códigos, HTTP
B3.5, B7.1–B7.5, B7.7

**Regra de fronteira:**
- **Payload inválido:** o que se decide **só olhando o payload**. Não é gravado. Responde `400`; na fila, vai para a DLQ.
- **Rejeição:** o que depende do **estado do banco**, decidido sob o lock da wallet. É gravado como `REJECTED`, com `failureCode`, evento e replay.
- **Exceção:** wallet inexistente responde `404` e não é gravado, porque não há wallet a que vincular a transação. Na fila, vai para a DLQ, que guarda a mensagem para reprocessar depois que a wallet existir.

| Situação | Classe |
|---|---|
| Schema, formato de `amount`, moeda fora da lista, `kind` `OPENING` ou desconhecido, referência faltando em `REFUND`/`ROLLBACK`, referência na `BET`, `Idempotency-Key` ausente ou com mais de 255 caracteres | Inválido (`400 VALIDATION_ERROR`) |
| Moeda diferente da wallet, wallet de outro `playerId`, saldo, referência (escopo, tipo, estado, já revertida, valor), teto de saldo | `REJECTED` |

**Códigos de falha** (gravados na transação; o que o provedor deve fazer):

| Código | Quando | Provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` sem saldo | desiste |
| `INSUFFICIENT_FUNDS_FOR_REVERSAL` | reversão que deixaria o saldo negativo | reenvia depois, com outro id |
| `CURRENCY_MISMATCH` | moeda ≠ moeda da wallet | corrige |
| `WALLET_PLAYER_MISMATCH` | wallet não é do `playerId` | corrige |
| `REFERENCE_NOT_FOUND` | prazo da pendência esgotado | corrige ou desiste |
| `REFERENCE_SCOPE_MISMATCH` | referência de outro player, wallet, moeda ou rodada (o campo divergente vai em `detail`) | corrige |
| `REFERENCE_KIND_NOT_ALLOWED` | tipo de referência não permitido (L381) | corrige |
| `REFERENCE_NOT_PROCESSED` | referência `REJECTED`/`FAILED` (vale para reversões, `WIN` e `LOSS`) | desiste |
| `REFERENCE_ALREADY_REVERSED` | já tem reversão `PROCESSED` | desiste |
| `AMOUNT_MISMATCH` | valor ≠ valor da referência | corrige |
| `BALANCE_LIMIT_EXCEEDED` | saldo passaria do teto | desiste |

O provedor nunca é aconselhado a "reenviar igual", porque um reenvio com a mesma key devolve replay.

**Status HTTP** (os mesmos em todos os endpoints, L508):

| Status | Quando |
|---|---|
| `200` | `PROCESSED`, inclusive `LOSS`; consultas; reconciliação |
| `201` | wallet criada |
| `202` | `PENDING_REFERENCE` |
| `400` | payload inválido, cursor inválido |
| `401` / `403` | sem token / sem permissão (D10) |
| `404` | recurso inexistente, ou de outro provedor |
| `409` | conflito de idempotência, `EXTERNAL_ID_CONFLICT`, `WALLET_ALREADY_EXISTS` |
| `422` | `REJECTED`, com o `failureCode` no corpo |
| `503` + `Retry-After` | banco fora, lock com timeout: transitório |

Replays usam o status do estado atual da transação. Para estados terminais, é sempre o da primeira resposta terminal.

**Contratos (B7.3, B7.4, B7.5):**
- O campo de referência se chama `referenceExternalTransactionId`, no nível de cima do corpo HTTP e dentro do `data` da mensagem, junto dos outros campos. É o mesmo nome da entidade (L247).
- Resposta de submissão: `{ transactionId, status, failureCode?, balance?, idempotentReplay }`. O `balance` é omitido enquanto a transação está pendente.
- `GET /wallets/:id`: o mesmo formato da criação, `{ id, playerId, balance, version }`.
- `GET` de transação (por id ou por id externo): `{ transactionId, providerId, externalTransactionId, walletId, playerId, roundId, gameId, kind, money, referenceExternalTransactionId?, referenceTransactionId?, status, failureCode?, balance?, createdAt, processedAt? }`.
- Item do ledger: `{ id, transactionId, direction, money, balanceBefore, balanceAfter, walletVersion, createdAt }`.
- Erros sem transação usam `{ error: { code, message, details? } }`.

**Infra fora (B7.7):**
- O HTTP **não depende do SQS**, porque publica pela outbox. Com o SQS fora, a API continua funcionando, mas a readiness fica falsa, porque a L533 define "pronto" como PostgreSQL **e** SQS alcançáveis. O nginx não roteia pela readiness, então o tráfego continua. Num orquestrador que roteia por readiness, isso tiraria a API do ar: limitação documentada.
- Com o banco fora, a API responde `503`.
- Prazos:

| Prazo | Valor |
|---|---|
| `lock_timeout` | 2 s |
| `statement_timeout` | 5 s |
| requisição HTTP | 10 s |

**Alternativa descartada:** `200` para `REJECTED`, com o status só no corpo. A L508 exige distinguir rejeição de sucesso pelo código HTTP.

---

## D6 — Wallet, OPENING, ledger e reconciliação
B3.15, B4.1–B4.9

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 6.1 | A `OPENING` fica na mesma tabela das transações, com as colunas do provedor **nulas**. Um `CHECK` exige nulas se o kind é `OPENING` e preenchidas nos outros kinds. Há também um índice parcial de uma `OPENING` por wallet. Ela não aparece na consulta por provedor (L468), mas aparece por id. | As unicidades ignoram nulos naturalmente. O ledger aponta para uma tabela só. | Valores sintéticos (um provedor falso suja o escopo e a auth); tabela separada (o ledger apontaria para duas tabelas). |
| 6.2 | A wallet nasce com `version: 1`, com ou sem `OPENING`. O lançamento da `OPENING` tem `wallet_version` 1, e a primeira mudança depois disso é a versão 2. A `OPENING` emite `WagerTransactionProcessed` e `WalletBalanceChanged`: ela é uma transação aplicada e o saldo mudou. | O exemplo do §9 mostra 1000.00 com `version: 1`. Criação não é incremento. | Versão 2 depois da `OPENING`: contradiz o exemplo. |
| 6.3 | `409 WALLET_ALREADY_EXISTS` devolve o `walletId` existente no corpo. | Um retry depois de timeout consegue seguir sem uma key nova. | `Idempotency-Key` no `POST /wallets`: não está no contrato. |
| 6.4 | `playerId`: string de 1 a 128 caracteres `[A-Za-z0-9._:-]`, sem cadastro de jogadores. | Não há contexto de jogador no enunciado. Exigir UUID poderia rejeitar ids legítimos. | Exigir UUID; cadastro de jogadores. |
| 6.5 | **Agregados:** `Wallet` é raiz; `debit`/`credit` alteram saldo e versão e **devolvem o `WalletLedgerEntry`**, então ninguém muda o saldo sem gerar lançamento (R-06-21). `WagerTransaction` é outro agregado. Um serviço de domínio aplica as regras de cada kind (D1) e coordena os dois. Os dois são gravados na mesma transação, sob o lock da wallet. **Desvio documentado:** dois agregados numa transação, porque o enunciado exige essa atomicidade (L363, L584). A fronteira real de consistência é a wallet travada. | Mantém as invariantes no domínio sem carregar o histórico inteiro. | Transações dentro do agregado `Wallet` (carregar o histórico é inviável); serviço anêmico sem agregado (perde a invariante). |
| 6.6 | Ids: UUIDv7, gerados na aplicação por uma porta `IdGenerator`. | Os ids do exemplo são v7: ordenáveis e bons para índices. | Gerados no banco: o domínio precisaria do id antes de gravar. |
| 6.7 | `initialBalance` é obrigatório. | A moeda da wallet vem dele (assinatura `open`, L180–184). | Opcional: a wallet ficaria sem moeda. |
| 6.8 | Ledger: ordem crescente de `wallet_version`; cursor opaco = base64url da última versão; `limit` padrão 50, máximo 200; resposta `{ items, nextCursor }`. | Lançamentos imutáveis e versão crescente fazem o cursor ser estável (L466). | Offset: instável com inserções. |
| 6.9 | **Reconciliação:** `calculatedBalance` = soma de créditos − débitos de todos os lançamentos (reconstrução independente, L715). Também verifica a continuidade (cada `balanceBefore` = o `balanceAfter` anterior) e o último `balanceAfter` = saldo armazenado. `checkedEntries` = número de lançamentos. Lê numa transação `REPEATABLE READ` sem travar escritas. Sempre `200`, com `consistent: false` e uma lista `issues` quando diverge, além de log de erro e métrica. Cada execução é gravada numa tabela append-only. **Não corrige nada.** | "Não corrigidas silenciosamente" (L527). Uma correção exigiria um fluxo aprovado por operador, fora do escopo. | Usar só o último `balanceAfter`: não detecta lançamento adulterado no meio. Lançamento de ajuste automático: inventa um kind. |

---

## D7 — Concorrência, banco e ORM
B5.1–B5.4

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 7.1 | **MikroORM** com `EntitySchema` (o domínio sem decorators), Unit of Work via `em.transactional()`, tipo customizado para `Money`. | Preferencial no enunciado (L83) e citado na vaga. | TypeORM. |
| 7.2 | **Lock pessimista na wallet** (`LockMode.PESSIMISTIC_WRITE`, `SELECT … FOR UPDATE`), mais uma checagem otimista da `version` na gravação como segunda camada. A `version` sobe **uma vez** por mudança de saldo, e por um único mecanismo (nunca o domínio e o ORM ao mesmo tempo). `lock_timeout` 2 s → `503`. | Hot wallet (§14): o lock serializa sem tempestade de retries. A idempotência, a referência e o saldo precisam ser decididos sob o mesmo lock. | Otimista com retry: com 50 em paralelo, quase tudo falha e repete. Update condicionado: protege o saldo, mas não as outras checagens. |
| 7.3 | **Garantias no banco:** unicidade, não-negatividade, imutabilidade, coerência e privilégios, detalhadas abaixo da tabela. | Tudo do §6 que o banco consegue garantir (§5.9). Inclui "toda alteração de saldo tem lançamento", que é do §6. | Só o mínimo (`UNIQUE` + `CHECK` de saldo): deixa a invariante saldo × ledger só no código. |
| 7.4 | Processos, todos com a mesma imagem e entrypoints diferentes:<br>• `api` ×3, atrás de um nginx;<br>• `consumer` ×3;<br>• `outbox-publisher` ×2;<br>• `pending-worker` ×2;<br>• `event-auditor` ×1 (D9.7).<br>O teste de ≥ 3 instâncias sobe 3 processos Bun separados contra a infra de teste. | Cada papel escala sozinho, e duplicar cada um prova que os claims com `SKIP LOCKED` funcionam. | Um processo só com tudo: não prova as instâncias. |

**As garantias do 7.3, uma a uma:**
- **Unicidade:**
  - wallet `(player_id, currency)`;
  - transação `(provider_id, idempotency_key)` e `(provider_id, external_transaction_id)`;
  - uma reversão `PROCESSED` por referência (D1);
  - uma `OPENING` por wallet;
  - ledger `(transaction_id)` e `(wallet_id, wallet_version)`;
  - inbox `(consumer_name, message_id)`.
- **Não-negatividade:** `CHECK` no saldo, nos valores e nos `balance_before`/`after`; `CHECK` da aritmética do lançamento.
- **Imutabilidade:** trigger que bloqueia `UPDATE`/`DELETE` no ledger; trigger que impede uma transação terminal de mudar e impede mudar colunas imutáveis.
- **Coerência:**
  - `CHECK` de referência por kind e de nulos na `OPENING`;
  - FK composta que obriga a referência a ser da mesma wallet, moeda e rodada. Por isso, o id interno da referência (`reference_transaction_id`) só é gravado quando a referência é válida. Uma transação rejeitada por escopo guarda só o id externo;
  - trigger de encadeamento do ledger (`balance_before` = `balance_after` anterior);
  - trigger diferido, conferido no commit, que exige saldo da wallet = último `balance_after`.
- **Privilégios:** a aplicação conecta com um papel sem `UPDATE`/`DELETE` no ledger; só as migrations usam o papel dono.

---

## D8 — Consumidor SQS
B6.2–B6.6 (B2.5–B2.7 ficaram na D3)

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 8.1 | Quem produz na fila são os provedores; o sistema não publica nela. As filas têm deduplicação por conteúdo ligada, então o `awslocal sqs send-message` precisa só de `--message-group-id`. O README recomenda `MessageGroupId = walletId` (ordem por wallet, paralelo entre wallets). O sistema aceita **qualquer** grupo: a correção não depende disso (L92, L416). | Funciona com a mensagem do §10 como está. | Exigir grupo ou atributos: quebra o exemplo. |
| 8.2 | Classificação:<br>• **Negócio** (`REJECTED`, `PENDING_REFERENCE`, replay) → ack.<br>• **Permanente** (JSON quebrado, schema, `type` desconhecido, `OPENING`, wallet inexistente, conflito de inbox) → o consumidor copia corpo e atributos **intactos** para a DLQ e apaga da fila, na hora.<br>• **Transitório** (banco fora, timeout de lock) → sem ack, `ChangeMessageVisibility` com backoff de 2ⁿ s até 300 s. | Atende L575 e L576 sem esperar 8 recebimentos para algo que nunca vai dar certo. | Deixar tudo para a política de redrive do SQS: mensagem permanente ficaria minutos girando. |
| 8.3 | As tentativas transitórias são contadas numa tabela `message_attempts`. Limite de 8; depois, DLQ. Como rede de segurança (por exemplo, uma mensagem que derruba o processo), a fila também tem `maxReceiveCount = 20`. | O `ApproximateReceiveCount` também conta devoluções por `SIGTERM` e crashes que não são culpa da mensagem: mandaria mensagens saudáveis para a DLQ. | Só `ApproximateReceiveCount`. |
| 8.4 | Identidade do provedor na fila: as mesmas validações de domínio do HTTP (formato, escopo das referências e da key). Sem cadastro de provedores. | Atende a L40 sem criar um contexto novo. | Cadastro de provedores: não é pedido. |
| 8.5 | `SIGTERM` no consumidor: para de buscar (o long poll é abortado); termina as mensagens em andamento em até 20 s; devolve com visibilidade 0 as recebidas e ainda não iniciadas. O Compose dá 30 s para o processo parar. | Faz as duas coisas da L577: concluir e devolver. | Só devolver: desperdiça trabalho quase pronto. |
| 8.6 | Os outros processos também tratam `SIGTERM`:<br>• API: readiness falsa, para de aceitar e termina as requisições em até 10 s.<br>• Publisher e worker: terminam o item atual; os leases vencem sozinhos. | "Shutdown" é avaliado (§14). | Tratar só o consumidor. |

---

## D9 — Outbox e eventos
B6.1, B6.7–B6.12, C2

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 9.1 | Os eventos são publicados num **tópico SNS FIFO** `wagering-events.fifo`, com uma fila SQS FIFO assinante. `MessageGroupId` = `walletId`; `MessageDeduplicationId` = `eventId` (só otimização). | SNS está na vaga (V-02, V-05) e permite fan-out: WebSocket, S3 e partidas dobradas entram depois como novos assinantes, sem mexer no núcleo. | Fila SQS direto: mais simples, mas cada novo consumidor exigiria mudar o publisher. |
| 9.2 | **Ordem por wallet:** o publisher só pega, de cada wallet, o evento mais antigo ainda não publicado. Os eventos de uma wallet saem em ordem; wallets diferentes saem em paralelo. | Com FIFO por `walletId`, o consumidor recebe na ordem certa. | **Sem ordem:** o consumidor ordena pelo `walletVersion`. Publisher mais simples, e um evento travado não segura os seguintes da wallet. |
| 9.3 | Coluna `ordering_key` (`walletId`) separada do `aggregateId`. O `aggregateId` é o `walletId` nos eventos da wallet e o `transactionId` nos eventos da transação. | Cada evento aponta para o seu agregado, e a ordem continua sendo por wallet. | — |
| 9.4 | `data` de cada evento:<br>• `WagerTransactionProcessed`: ids, `kind`, `money`, `referenceTransactionId?`, `balanceAfter`, `walletVersion?`;<br>• `WagerTransactionRejected`: ids, `kind`, `money`, `failureCode`;<br>• `WagerTransactionPendingReference`: ids, `kind`, `referenceExternalTransactionId`;<br>• `WalletBalanceChanged`: o do enunciado.<br>Eventos extras: `WalletOpened` e `WagerTransactionFailed`. | A lista é "mínima" (L596). Abertura e `FAILED` também são mudanças de estado relevantes. | Só os 4 eventos: abertura e `FAILED` ficariam invisíveis para os consumidores. |
| 9.5 | `correlationId`:<br>• HTTP: header `X-Correlation-Id` se for válido, senão gerado;<br>• SQS: o `messageId` do corpo;<br>• worker: o da transação original, guardado numa coluna `correlation_id`.<br>`causationId` = o id do comando que causou o evento (`messageId` ou id da requisição). | Uma operação fica rastreável do começo ao fim nos logs (§12). | — |
| 9.6 | Publisher: pega um lote de até 50 com `SKIP LOCKED` e lease de 30 s, numa transação curta; publica; marca `published_at`. Em falha: tentativas + 1 e backoff até 5 min. **Nunca descarta**: depois de 20 tentativas, sinaliza numa métrica e num alerta, mas continua tentando. | "Não perder eventos confirmados" (§3). Uma DLQ da outbox seria perder. | Descartar depois de N tentativas. |
| 9.7 | Um consumidor interno dos eventos (`event-auditor`) lê a fila assinante e deduplica pelo `eventId` com a mesma inbox. Um teste publica o mesmo evento duas vezes e confirma um único efeito. | Demonstra a L594: "publicação duplicada continua segura para o consumidor". | Não ter consumidor: a L594 ficaria sem prova. |

---

## D10 — Autenticação
B8.1, B8.2, B7.6

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 10.1 | **Keycloak** com OAuth2 `client_credentials`: um client por provedor e um client `operator`. O token traz o claim `provider_id` e um papel (`provider` ou `operator`). A API valida com `jose` (JWKS, emissor, audiência, expiração, algoritmo), num adaptador do `ProviderIdentityPort`. | IdP externo (L34). É o mais comum no mercado. | Não implementar (aceito, mas fica só no papel); Zitadel; auth artesanal. |
| 10.2 | Permissões: as da tabela abaixo. | O cassino cria wallets; o estúdio de jogos submete apostas. O `404` não revela o que é de outro provedor. | Um papel só. |
| 10.3 | Sem chave para desligar a auth. Os testes usam um emissor de teste configurado; um teste e2e roda contra o Keycloak real. O README tem um comando para pegar o token e mostra os `curl` do §9 com o header. A fila não tem auth (L40). | O mesmo código de validação roda nos testes e em produção. | Uma variável "AUTH_DISABLED": vira brecha. |
| 10.4 | O guard, as regras e os testes com token entram no núcleo **desde o início**. O container do Keycloak entra na última fatia do núcleo. | Fazer depois obrigaria a reescrever todos os testes HTTP. | — |

**Permissões (10.2):**

| Endpoint | `provider` | `operator` |
|---|---|---|
| criar wallet, reconciliação | ✗ | ✓ |
| submeter transação | só com o `providerId` do token (senão `403`) | ✗ |
| consultar transação | só as próprias (de outro provedor, ou `providerId` da rota diferente do token: `404`) | todas |
| consultar wallet e ledger | ✓ | ✓ |
| health | aberto | aberto |

---

## D11 — Observabilidade, testes e documentação
B9.1–B9.5

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 11.1 | Logs JSON com `pino`. Os campos `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` entram automaticamente, via `AsyncLocalStorage`. **Nunca** entram: valores, saldos, payloads, o header `Authorization` e o `playerId`. | Atende a L673 e a L674. O `playerId` identifica uma pessoa, então fica fora por precaução. | Logar valores: são "payloads financeiros". |
| 11.2 | Métricas com `prom-client` em `/metrics`, numa porta interna sem auth. A lista está abaixo da tabela. | Cobre a lista mínima (L675) e o "diagnóstico" (§14). | — |
| 11.3 | Health:<br>• `/health/live`: o processo responde;<br>• `/health/ready`: `SELECT 1` e `GetQueueAttributes` no SQS, com timeout de 1 s cada. | L532, L533. | — |
| 11.4 | Testes:<br>• unidade com fast-check (propriedades de `Money` e do ledger);<br>• integração com Postgres e LocalStack reais;<br>• concorrência com processos reais, sincronizada por `pg_locks` em vez de `sleep` ("determinismo", §14);<br>• provas que removem uma proteção e exigem que um teste falhe.<br>O invariante saldo = ledger roda no fim de todo teste com banco. Nos testes de unidade, roda sobre os lançamentos devolvidos pelo domínio. | L712, L729. | — |
| 11.5 | A visão geral e tudo que o §14 exige documentar ficam no `ARCHITECTURE.md`, em seções próprias: transições, taxonomia, hash, prazos, interpretações e limitações. O detalhe de cada parte fica no README dela (D13.1), com link a partir do `ARCHITECTURE.md`. O README da raiz fica com setup e comandos. | Um lugar só para o avaliador começar a ler. | — |
| 11.6 | OpenTelemetry, Jaeger, Grafana e o teste de carga k6 (`bun run test:load`) são **extras**, feitos depois do núcleo. | Opcionais (L678, L746). | — |

**As métricas do 11.2:**
- transações por status, kind e canal;
- duplicatas por camada (key, inbox);
- retries por componente;
- mensagens na DLQ por motivo, mais a profundidade da DLQ;
- conflitos de lock e o tempo de espera por lock;
- outbox: lag e quantidade pendente;
- latência de processamento;
- divergências de reconciliação;
- `refund_after_settlement` (D1).

---

## D12 — Extras que tocam o núcleo
C1, C3, C4, C5

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 12.1 | **Partidas dobradas assíncronas:** um contexto `accounting`, com schema próprio, consome `WalletBalanceChanged` pelo SNS e grava um diário de partidas dobradas, deduplicando pelo `eventId`. É um extra, feito depois do núcleo. | Não mexe na transação do núcleo, e é um bom exemplo de DDD e eventos para a vaga. | **Síncrono**, na mesma transação: consistência imediata, mas complica o núcleo e o lock. |
| 12.2 | "Microsserviços": o núcleo é **um serviço** (um código, um banco) rodando como vários processos. Os extras (`realtime`, `accounting`) são serviços separados que só conversam por eventos. | Separar o núcleo em bancos diferentes quebraria a atomicidade que o enunciado exige (L584). | Partir o núcleo em serviços. |
| 12.3 | Secrets Manager: o núcleo lê as credenciais por uma porta `SecretsProvider`, com adaptador de variável de ambiente. O adaptador do Secrets Manager, no LocalStack, é um extra. | O encaixe existe desde o início, sem tornar o Secrets Manager obrigatório para rodar os testes. | — |
| 12.4 | WebSocket: o serviço `realtime` assina o SNS e envia aos clientes os eventos da wallet que eles seguem, com token. É um extra. | Usa o encaixe 9.1 sem tocar o núcleo. | — |

---

## D13 — Documentação por parte, Swagger e diagramas

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 13.1 | Cada módulo (`src/modules/<contexto>/`) e cada área de `src/shared/` tem um `README.md` curto: o que faz, as regras principais citando os IDs (`R-…`, `D…`) sem copiar o texto das decisões, o fluxo de uma operação e onde estão os testes que provam cada regra. | Quem lê entende cada parte sem ler tudo. Citar IDs evita texto duplicado e desatualizado. | Um documento gigante só no fim. |
| 13.2 | Swagger (OpenAPI) com `@nestjs/swagger` em `/docs`, aberto como o health. Cada endpoint documenta corpo, respostas e todos os status HTTP da D5, com o esquema Bearer quando a auth existir (D10). | O avaliador entende a API sem ler o código. Os status da D5 ficam visíveis. | Documentar endpoints só no README. |
| 13.3 | A documentação é escrita na fatia que cria a parte, não no fim. | Fica correta e não acumula. | Escrever tudo na S10. |
| 13.4 | Diagramas Mermaid só onde o texto explica mal, na fatia que cria a parte: estados da transação (S1), modelo de dados (S2), processamento de uma transação (S4), ciclo da mensagem SQS (S6), outbox com queda (S7) e visão geral dos processos (S8). | O GitHub renderiza Mermaid; é texto versionado. Cada diagrama responde uma pergunta que o avaliador faria. | Diagramas em imagem (desatualizam e não aparecem no diff); diagramas para tudo (viram ruído). |

---

## D14 — Detalhes do domínio (S1)
Pontos que a implementação da S1 encontrou abertos. Cada um complementa a decisão citada.

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 14.1 | Complementa D4.2 e D5. Código `PROCESSING_FAILED` para o `FAILED` (provedor: contata o operador). É o único código usado por `fail()`. | `fail(code: FailureCode)` (L268) exige um código, e a tabela da D5 só tinha códigos de rejeição. | Gravar `FAILED` sem código: quebra a assinatura e deixa o estado sem explicação legível por máquina. |
| 14.2 | Complementa D5 e D1. Ordem das checagens, a primeira violação vence:<br>1. wallet de outro `playerId` → `WALLET_PLAYER_MISMATCH`;<br>2. moeda ≠ moeda da wallet → `CURRENCY_MISMATCH`;<br>3. referência ausente → espera (`PENDING_REFERENCE`);<br>4. escopo da referência → `REFERENCE_SCOPE_MISMATCH`;<br>5. tipo da referência → `REFERENCE_KIND_NOT_ALLOWED`;<br>6. estado da referência: pendente → espera; terminal sem ser `PROCESSED` → `REFERENCE_NOT_PROCESSED`;<br>7. já revertida → `REFERENCE_ALREADY_REVERSED`;<br>8. valor ≠ valor da referência → `AMOUNT_MISMATCH`;<br>9. saldo ou teto → `INSUFFICIENT_FUNDS`, `INSUFFICIENT_FUNDS_FOR_REVERSAL` ou `BALANCE_LIMIT_EXCEEDED`. | Determinística e testável. Primeiro o que vale para qualquer kind, depois o que é decidível sem esperar (escopo e tipo não mudam com o tempo), por último o que depende de saldo. Esperar por uma referência que já seria rejeitada por escopo só atrasaria a resposta. | Ordem livre: o mesmo payload poderia receber códigos diferentes, e o replay ficaria imprevisível. Checar estado antes do escopo: espera inútil. |
| 14.3 | Complementa D5 (`REFERENCE_SCOPE_MISMATCH`, "o campo divergente vai em `detail`"). O domínio devolve `failureDetail` (`PLAYER`, `WALLET`, `CURRENCY` ou `ROUND`), gravado numa coluna e devolvido como `failureDetail?` na resposta de submissão (inclusive no replay) e no `GET` de transação. | A D5 promete o `detail`, e o replay precisa devolver o mesmo resultado (D3.4), então ele tem que estar gravado. | Só no log: o provedor não saberia qual campo corrigir. |
| 14.4 | Complementa D9.4. Os "ids" dos eventos de transação são `transactionId`, `walletId`, `providerId`, `externalTransactionId`, `roundId` e `gameId` (nulos na `OPENING`), **sem** `playerId`. `WalletOpened.data` = `{ walletId, playerId, currency, initialBalance: MoneyProps, walletVersion: 1 }`. `WagerTransactionFailed.data` = ids + `kind` + `money` + `failureCode`. | Fecha o "ids" da D9.4 e dá `data` aos dois eventos extras. O `playerId` identifica uma pessoa (D11.1) e já está ligado à wallet; só o `WalletOpened` o carrega, porque é o evento que cria esse vínculo. | `playerId` em todo evento: espalha um dado pessoal sem necessidade. |
| 14.5 | Complementa D6.1. Na `OPENING` ficam nulos `providerId`, `externalTransactionId`, `idempotencyKey`, `payloadHash`, `roundId` e `gameId`; `walletId`, `playerId`, `kind` e `money` ficam preenchidos. Ela nasce por uma fábrica própria, `WagerTransaction.opening(...)`; o `create` recusa `OPENING` (R-06-38). | Fecha a lista de "colunas do provedor" da D6.1. Uma fábrica separada impede, por tipo, que a API ou a fila criem uma `OPENING`. | Um `create` que aceita `OPENING` com um flag: a regra R-06-38 ficaria numa checagem fácil de esquecer. |
| 14.6 | Complementa D3.5 e D7.3 (e usa a R-06-01 para adaptar a assinatura). `markProcessed({ referenceTransactionId?, balanceAfter, at })` e `reject(code, { balanceAfter, detail? })`. `processedAt` e `referenceTransactionId` só existem no `PROCESSED`. | A entidade precisa do `balance_after` para o replay (D3.5). O id interno da referência só é gravado quando a referência é válida (D7.3), e só o `PROCESSED` garante isso. `processedAt` segue o esqueleto (L265). | Gravar `referenceTransactionId` também em rejeições por valor ou tipo: a regra "só quando válida" ficaria caso a caso. |
| 14.7 | Complementa D2.5 e D2.6. `Money.from` valida só o formato da moeda (`^[A-Z]{3}$`). A lista configurada (`BRL`, `USD`) é checada no contrato de entrada (zod), e moeda fora da lista é `400`. | O domínio não lê config (camadas). A lista é configurável, então pertence à borda. | Passar a lista para `Money.from`: todo call site do domínio carregaria config. |
| 14.8 | Complementa a regra de dinheiro da D2 (`CLAUDE.md`). O lint nega o global `Math` em `domain/`, e um teste de unidade procura `toFixed`, `Number(`, `parseFloat`, `parseInt` e `Math.` nos arquivos de `src/**/domain/**`. | Hoje o lint só nega `Number`, `parseInt` e `parseFloat`; a regra também proíbe `Math.*` e `toFixed`, e o `toFixed` não é um global que o Biome consiga negar. | Confiar na revisão: a regra fica sem garantia automática. |
| 14.9 | Complementa D1.6 e D1.1. `WIN`/`LOSS` que referencia uma `BET` já reembolsada é aceito. Um `WIN`/`LOSS` com referência não confere o valor (a R-07-10 vale só para reversões). Documentado no README do domínio. | A D1.1 só limita reversões, e a D1.6 não tem estado de rodada. O valor de um ganho não tem relação com o da aposta. | Bloquear `WIN` depois de `REFUND`: inventa uma regra de rodada que a D1.6 descartou. |

---

## D15 — Complementos do schema (S2)
Garantias que a S2 levou para o banco além da lista da D7.3. Cada uma reforça uma regra já decidida; nenhuma cria regra de negócio.

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 15.1 | Complementa D7.3 e R-06-27. O trigger de cauda diferido confere também `wallet.version` = último `wallet_version`, ou 1 sem lançamento. | "Version só muda quando o saldo muda" vira garantia do banco, não só do domínio. | Conferir só o saldo: uma `version` que sobe sem lançamento passaria. |
| 15.2 | Complementa D2.4. `CHECK` do teto de saldo: `balance < 10^15`. | O `numeric(20,2)` aceita 18 dígitos inteiros; o teto da D2.4 é 15. Defesa no banco, além do `BALANCE_LIMIT_EXCEEDED` do domínio. | Só o domínio. |
| 15.3 | Complementa D4.1, D4.2, D14.1, D14.3 e D14.6. `CHECK`s por status: `PENDING` nunca gravado; `PROCESSED` exige `processed_at` e `balance_after`, sem `failure_code`, e tem o id interno da referência se e só se tem a externa; `REJECTED` exige `failure_code` ≠ `PROCESSING_FAILED` e `balance_after`; `FAILED` só com `PROCESSING_FAILED`; `PENDING_REFERENCE` sem saldo nem código; `failure_detail` se e só se `REFERENCE_SCOPE_MISMATCH`; `reference_transaction_id` só no `PROCESSED`. | As regras de estado da entidade ficam garantidas também contra SQL direto. | Só a entidade. |
| 15.4 | Complementa D7.3. FKs compostas `ledger (wallet_id, currency) → wallets (id, currency)` e `ledger (transaction_id, wallet_id, currency) → wager_transactions (id, wallet_id, currency)`. | O lançamento é da moeda da wallet e da transação que o gerou. | Confiar no código para a moeda do lançamento. |
| 15.5 | Complementa D4.5 e D4.2. Transições no banco: o `CHECK` de status só aceita `PENDING_REFERENCE` e os terminais; um trigger de `INSERT` recusa `FAILED`, então um `INSERT` só grava `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`; o trigger de `UPDATE` recusa qualquer mudança de uma linha terminal e das colunas da submissão. O único caminho que sobra é `PENDING_REFERENCE → PROCESSED | REJECTED | FAILED` (ou ficar, mexendo só nas colunas de controle), e o `FAILED` só nasce por `UPDATE` a partir de `PENDING_REFERENCE`. | Explícito e sem código morto: as três peças juntas fecham a máquina de estados. Sem o trigger de `INSERT`, um `FAILED` poderia nascer sem nunca ter sido uma pendente, contra a D4.2. | Um trigger que repete a tabela de transições. |
| 15.6 | Complementa D6.2. Encadeamento do primeiro lançamento: `balance_before = 0`, com `wallet_version` 1 se for a `OPENING` e 2 se não houver `OPENING`. A `OPENING` só pode ser o primeiro lançamento. | A wallet nasce com `version` 1 com ou sem `OPENING`, então a primeira movimentação sem `OPENING` é a versão 2. | Aceitar qualquer versão no primeiro lançamento: deixa um buraco no início da cadeia. |
| 15.7 | Complementa D7.2. Sem o versionamento do ORM, a segunda camada da D7.2 é o `UNIQUE (wallet_id, wallet_version)` do ledger mais o trigger de cauda (15.1): dois escritores sem lock geram a mesma versão e um deles é recusado pelo banco. | Mantém "um mecanismo só" para subir a `version` (o domínio) e ainda assim tem uma barreira se o lock faltar. | `version: true` do MikroORM: seria um segundo mecanismo incrementando a `version`. |
| 15.8 | Complementa D3.5. A moeda do `balance_after` fica numa coluna própria, `balance_after_currency`, com FK `(wallet_id, balance_after_currency) → wallets (id, currency)` e um `CHECK` que exige as duas colunas nulas ou as duas preenchidas. | No `CURRENCY_MISMATCH`, o saldo observado está na moeda da **wallet**, não na da transação, então a moeda da transação não serve para reconstruir esse `Money`. A FK garante que ela é a moeda da wallet. | Reusar a coluna `currency` da transação: erra justamente no `CURRENCY_MISMATCH`. Buscar a moeda na wallet a cada leitura: o mapper dependeria de um join só para isso. |
| 15.9 | Complementa R-06-24, R-06-43 e R-05-09 (§5.9). Coerência lançamento × transação, com constraint triggers diferidos, conferidos no commit: (1) todo lançamento aponta para uma transação `PROCESSED` da mesma wallet (a wallet já vem da FK da 15.4), com a direção do kind: `BET` → `DEBIT`; `WIN`, `REFUND` e `OPENING` → `CREDIT`; `ROLLBACK` → o inverso da referência; (2) toda transação `PROCESSED` que não é `LOSS` tem exatamente um lançamento (o "no máximo um" é o `UNIQUE (transaction_id)`); (3) `LOSS`, `REJECTED` e `PENDING_REFERENCE` (e `FAILED`) não têm lançamento. | "Toda alteração de saldo tem um lançamento correspondente **e vice-versa**" (R-06-24) e "operações sem efeito no saldo não geram lançamento" (R-06-43) ficam garantidos contra SQL direto, não só no domínio. A cauda (15.1) conferia só saldo × ledger; uma `BET` `PROCESSED` sem lançamento, ou um lançamento de uma transação `REJECTED`, passavam. | Só o domínio: a regra ficaria sem garantia no banco. Conferir na hora do `INSERT`: o use case e o worker gravam transação, lançamento e status em comandos separados, então só no commit o estado está completo. |
| 15.10 | Complementa D15.4 e R-06-26. Coluna gerada `processed_currency = CASE WHEN status = 'PROCESSED' THEN currency END`, com FK `(wallet_id, processed_currency) → wallets (id, currency)`. | Toda transação `PROCESSED`, inclusive `LOSS` (que não tem lançamento, então a FK da 15.4 não a alcança), tem a moeda da wallet. As `REJECTED` por `CURRENCY_MISMATCH` continuam aceitas, porque a coluna fica nula fora do `PROCESSED`. | FK direta `(wallet_id, currency)`: recusaria a `REJECTED` por `CURRENCY_MISMATCH`, que precisa ser gravada (D5). Trigger: mais código para o que uma FK resolve. |

---

## D16 — Detalhes de HTTP, auth e reconciliação (S3)
Pontos que o plano da S3 encontrou abertos. Cada um complementa a decisão citada.

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 16.1 | Complementa D10.1. O papel vem em `realm_access.roles` (`provider` ou `operator`); o provedor, no claim `provider_id`. Token sem nenhum dos dois papéis, ou `provider` sem `provider_id` → `401`. Só `RS256`. | É o lugar padrão do Keycloak para papéis de realm: a S10 só precisa de um mapper para o `provider_id`. | Claim próprio `role`: mais um mapper no Keycloak. |
| 16.2 | Complementa D5 (erros sem transação). Códigos: `VALIDATION_ERROR` (400, inclusive cursor e `limit`), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `WALLET_ALREADY_EXISTS` e `EXTERNAL_ID_CONFLICT` (409), `TEMPORARILY_UNAVAILABLE` (503), `INTERNAL_ERROR` (500). | Um código por categoria da L508: o provedor decide pelo código, sem ler a mensagem. | Código genérico por status. |
| 16.3 | Complementa D5. `Retry-After: 1` (segundos) em todo `503`. | O transitório típico é um `lock_timeout` de 2 s: um segundo é um reenvio rápido sem martelar. | Backoff no servidor: o provedor já faz o seu. |
| 16.4 | Complementa D5 e D14.1. No `Record<FailureCode, HttpStatus>`, todo código de rejeição → `422`; `PROCESSING_FAILED` → `500`. | `422` é rejeição por regra de negócio; `FAILED` é erro permanente de infraestrutura, e a L508 exige não misturar categorias. Reenviar não causa dano: com a mesma key, devolve o replay. O código diz ao provedor para contatar o operador. | `422` para tudo: mistura erro de infraestrutura com rejeição de negócio. |
| 16.5 | Complementa D6.9. `issues` aparece sempre (vazia quando consistente), com itens `{ code, walletVersion? }`: `BALANCE_MISMATCH` (calculado ≠ armazenado), `CHAIN_BREAK` (o `balanceBefore` do lançamento N ≠ o `balanceAfter` do N−1, com a versão N), `TAIL_MISMATCH` (último `balanceAfter` ≠ armazenado). | Formato fixo e legível por máquina; cada código é uma das três checagens da D6.9. | Mensagens de texto livre. |
| 16.6 | Complementa D11.2 e o aceite da S3. A métrica de divergência entra na S3: porta `ReconciliationMetrics` na `application/` e adaptador `prom-client` com o contador `reconciliation_divergences_total`. O endpoint `/metrics` fica na S9. | O aceite da S3 pede a métrica; a porta mantém o `prom-client` fora da `application/`. | Antecipar o `/metrics`: é escopo da S9. |
| 16.7 | Complementa D9.5. `X-Correlation-Id` válido = `^[A-Za-z0-9._:-]{1,128}$` (o formato da D6.4); fora disso, um UUIDv7 gerado. `causationId` = id da requisição (UUIDv7). O `correlationId` volta no header `X-Correlation-Id` da resposta. | Aceita os ids comuns dos provedores sem deixar entrar texto arbitrário nos logs. | Aceitar qualquer string: injeção nos logs. |
| 16.8 | Complementa D5. `walletId` da rota que não é UUID → `400 VALIDATION_ERROR`. | É decidível só pelo payload (regra de fronteira da D5). | `404`: mistura "não existe" com "pedido mal formado". |
| 16.9 | Complementa D6.8 e R-09-07. Com ordem crescente de `walletVersion` e ledger append-only, só existem inserções no fim. "Cursor estável" quer dizer: lançamentos gravados entre duas páginas aparecem na página seguinte, sem duplicata nem furo. | Não existe "inserção no meio" neste ledger; o critério testável é o que sobra. | Exigir estabilidade contra inserção no meio: cenário impossível de montar sem violar a D7.3. |
| 16.10 | Complementa D10.2 e D16.1. Um token com os dois papéis (`provider` e `operator`) tem as permissões dos dois. | `@Roles` exige um dos papéis listados; somar permissões é o comportamento esperado de papéis. | Recusar tokens com dois papéis: regra sem motivo no enunciado. |
| 16.11 | Complementa D6.9, D16.5 e D15.6. `CHAIN_BREAK` também no primeiro lançamento com `balanceBefore` ≠ 0, com a versão dele. | O primeiro lançamento sempre parte de 0 (D15.6); o "anterior" do primeiro é o saldo zero. | Ignorar o primeiro: um início de cadeia adulterado passaria. |
| 16.12 | Complementa D6.9 e D16.5. `TAIL_MISMATCH` = `balanceAfter` do último lançamento (por `walletVersion`) ≠ saldo armazenado; sem lançamento, compara 0 com o saldo armazenado. | É a checagem "último `balanceAfter` = saldo armazenado" da D6.9, com o caso sem lançamento fechado (wallet aberta com 0, D2.3). | Pular a checagem sem lançamento: saldo positivo sem nenhum lançamento passaria só com `BALANCE_MISMATCH`. |
| 16.13 | Complementa D5 e D16.2. Erros 4xx do próprio framework antes do controller (JSON mal formado, `413`, `415` etc.) viram `400 VALIDATION_ERROR`; rota inexistente, `404 NOT_FOUND`. | São decidíveis só pelo payload (fronteira da D5); um código por categoria (D16.2). | Repassar o status do framework: categorias fora da tabela da D5. |
| 16.14 | Complementa D13.2. `/docs-json` (o OpenAPI em JSON) é aberto como o `/docs`. | É a mesma documentação, em formato de máquina. | Proteger o JSON: o `/docs` aberto depende dele. |
| 16.15 | Complementa D10.1 e D5. O corpo é lido (parse do JSON) antes da autenticação, então JSON mal formado responde `400` mesmo sem token. A validação do schema (zod) acontece depois do guard: corpo válido como JSON, mas fora do schema, sem token → `401`. | O parser do corpo é middleware do framework e roda antes dos guards; nada é gravado nem logado nesse caminho. | Autenticar antes do parse: exigiria trocar o parser do framework sem ganho de segurança. |
| 16.16 | Complementa D5, D10.1 e D16.3. JWKS do emissor indisponível (resposta não-200, conexão recusada ou timeout) → `503 TEMPORARILY_UNAVAILABLE` com `Retry-After`. Timeout do JWKS em `AUTH_JWKS_TIMEOUT_MS` (padrão 5 s, o do `jose`). | O token pode ser válido: a falha é do IdP, transitória. `401` diria ao provedor que o token está errado. | `401`: categoria errada; `500`: não diz que reenviar resolve. |

---

## D17 — Detalhes da submissão de transação (S4)
Pontos que o plano da S4 encontrou abertos. Cada um complementa a decisão citada.

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 17.1 | Complementa D5 e D6.4. `providerId`, `externalTransactionId`, `referenceExternalTransactionId`, `roundId` e `gameId`: string `^[A-Za-z0-9._:-]{1,128}$` (o formato da D6.4). Fora disso → `400 VALIDATION_ERROR`. | Os exemplos do §9 passam, e nenhum texto arbitrário chega aos logs (o `providerId` é campo de log, D11.1). | 1 a 255 caracteres livres: deixa entrar texto arbitrário nos logs. |
| 17.2 | Complementa D5, D16.2 e R-09-16. Mesma key com payload diferente → `409 IDEMPOTENCY_KEY_CONFLICT`. Os dois conflitos de transação (`IDEMPOTENCY_KEY_CONFLICT` e `EXTERNAL_ID_CONFLICT`) levam `details.transactionId`, o id da transação que já existe. | Um código por situação (D16.2). A transação é do mesmo provedor, então nada vaza; o provedor consegue consultá-la (mesma lógica da D6.3). | Sem `details`: o provedor teria de procurar a transação. |
| 17.3 | Complementa D16.8. `transactionId` da rota que não é UUID, ou `providerId` da rota fora do formato da 17.1 → `400 VALIDATION_ERROR`. | Decidível só pelo payload (fronteira da D5). | `404`: mistura "não existe" com "pedido mal formado". |
| 17.4 | Complementa D4.3 e D4.4. A submissão (S4) já grava `PENDING_REFERENCE`, com o evento e `202`, e com `next_attempt_at = created_at` (já vencida). O worker (S5) faz a primeira tentativa no próximo tick e aplica o backoff dali em diante. A "cutucada" (D4.4) entra na S5. | Uma pendente gravada nunca fica sem `next_attempt_at`, então nunca fica fora do claim do worker. | Deixar nulo até a S5: pendentes gravadas antes ficariam invisíveis ao worker. |
| 17.5 | Complementa D3.6 e R-13-C1. O pool do `pg` fica no padrão (10 conexões por processo). No teste das 50 em paralelo, o lock da wallet é segurado por uma transação crua até as 10 conexões do pool aparecerem esperando no `pg_locks` (as outras 40 ficam na fila do pool); só então é solto. O teste com várias instâncias de verdade (R-13-C4) é da S8. | Prova a disputa real no lock sem mudar a configuração de produção. Várias instâncias são o objeto da S8 (D7.4). | Pool configurável só para o teste caber no `pg_locks`; processos múltiplos já na S4. |
| 17.6 | Complementa D3.6. Se a repetição única da D3.6 bater de novo num `UNIQUE` de key ou de id externo, a resposta é `503 TEMPORARILY_UNAVAILABLE` com `Retry-After` (conflito transitório). Reenviar com a mesma key cai no replay ou no `409`. | A segunda violação só acontece com uma corrida nova durante a repetição; reenviar resolve, e nada foi gravado. | `500`: trata uma corrida como bug; repetir sem limite: laço sob disputa. |
| 17.7 | Complementa D11.2 ("duplicatas por camada"). Contador `wagering_duplicates_total{layer}`, com `layer` = `fast_path` (checagem rápida), `lock` (checagem autoritativa sob o lock) ou `unique_index` (o `UNIQUE` barrou o commit; a repetição que vem depois não conta de novo). Contado já na S4; o `/metrics` continua na S9. A inbox ganha a sua camada na S6. | Prova que as duplicatas simultâneas param no lock, não no índice: nas 50 em paralelo, `fast_path + lock = 49` e `unique_index = 0`. Sem isso, o retry da D3.6 esconderia uma checagem fora do lock. | Inferir pelo status HTTP: o retry devolve o mesmo `200`. |

Detalhes seguidos na S4 sem regra nova: `Idempotency-Key` vazia conta como ausente (`400`); campos extras do corpo são descartados, como no `POST /wallets`; ordem na borda: guard (`401`; `403` para quem não é `provider`) → schema (`400`) → `providerId` do corpo ≠ token (`403`) → use case; a checagem rápida da key (antes do lock) vem antes da busca da wallet; a referência não é travada, porque uma referência válida é da wallet já travada (D14.2: escopo antes de estado).

---

## D18 — Detalhes do worker de pendentes (S5)
Pontos que o plano da S5 encontrou abertos. Cada um complementa a decisão citada.

| # | Decisão | Por quê | Alternativa descartada |
|---|---|---|---|
| 18.1 | Complementa D4.2 e D4.3. Coluna nova `consecutive_errors` (`int NOT NULL DEFAULT 0`, `>= 0`), em migration própria. `attempts` conta **toda** tentativa e define o backoff; `consecutive_errors` conta os erros seguidos e volta a 0 numa tentativa sem erro. | O backoff da D4.3 conta tentativas, inclusive as que terminam "ainda pendente"; os "5 erros seguidos" da D4.2 são outra contagem. | Backoff pelo tempo desde a criação: deixa de ser "dobrando" como a D4.3 descreve. |
| 18.2 | Complementa D4.3. Lease de 30 s (como o publisher, D9.6) e lote de 10. O claim usa o `now()` do banco e pula linhas com lease vigente (`locked_until > now()`). | Com lote 10 e `lock_timeout` de 2 s por item, o pior caso (~20 s) cabe no lease. O relógio do banco é o mesmo para todas as instâncias. | Lote de 50: o pior caso passaria do lease. |
| 18.3 | Complementa D9.5. Nos eventos do worker, `causationId` = um UUIDv7 por tentativa; `correlationId` = a coluna `correlation_id` da submissão original. | Cada tentativa é um comando próprio; a operação continua rastreável pela correlação. | Usar o id da transação como causação: não distingue as tentativas. |
| 18.4 | Complementa D4.2. Erro `transient` no `classifyError()` → `attempts + 1` e backoff, sem contar erro. Qualquer outra categoria → `attempts + 1`, `consecutive_errors + 1` e backoff. No 5º erro seguido, uma transação própria trava a wallet e a linha, relê e, se ainda pendente, grava `fail(PROCESSING_FAILED)`, o evento `WagerTransactionFailed` e a cutucada. | "Não de negócio e não transitório" (D4.2). Transitório resolve sozinho e não é culpa da transação. | Contar transitórios: um Postgres instável marcaria pendentes saudáveis como `FAILED`. |
| 18.5 | Complementa D4.3. A tentativa avalia primeiro e só expira se a decisão ainda for esperar (referência ausente ou pendente). O `next_attempt_at` nunca passa de `created_at + 15 min`. | Uma referência que chegou no fim do prazo é aplicada; a expiração acontece no prazo, não até 60 s depois. | Expirar sem avaliar: rejeita uma transação que já podia ser aplicada. |
| 18.6 | Complementa D4.4. A cutucada acontece em toda transição para terminal, na submissão e no worker (cadeia `BET ← REFUND ← ROLLBACK` pendentes). Só põe `next_attempt_at = now()`, sem mexer em tentativas nem lease, com `SKIP LOCKED`. | "Chega a um estado terminal" vale também para uma pendente resolvida pelo worker. | Cutucar só na submissão: o elo seguinte da cadeia esperaria o backoff. |
| 18.7 | Complementa D7.4. Na S5, "dois workers" são duas instâncias no processo de teste, cada uma com seu MikroORM e seu pool. Processos separados ficam para a S8 (R-13-C4). | Prova o `SKIP LOCKED` e o lease sem antecipar a topologia da S8. | Processos já na S5. |
| 18.8 | Complementa D8.6. O runner tem `stop()`, que termina o item atual; o entrypoint liga o `SIGTERM` a ele. O teste de `SIGTERM` é da S8. | Os testes precisam parar o worker de forma limpa. | — |
| 18.9 | Complementa D1.3. O claim ordena por `next_attempt_at` e depois por `created_at`, e o lote é processado nessa ordem. Quando duas reversões pendentes esperam a mesma referência, a mais antiga vence. | A cutucada põe o mesmo `now()` nas duas; o desempate pela criação deixa o resultado determinístico. | Ordem livre: o vencedor dependeria do plano de execução. |
| 18.10 | Complementa D18.2. Dono do lease: coluna `locked_by uuid` (migration própria). Cada worker tem um token; o claim grava `locked_by = token` junto com o lease. A tentativa e o registro de erro, depois de travar a wallet e a linha, só seguem se `locked_by` ainda é o token deles; senão, `skipped`, sem gravar nada. `resolve` e `reschedule` limpam `locked_by` com o lease. | Com o lote inteiro esperando locks, o lease de 30 s pode vencer com o item em processamento; outro worker reclama a linha e os dois tentariam a mesma pendente (tentativas e erros contados em dobro). | Lease maior: só adia o caso. Lote menor: o mesmo problema com locks lentos. |
| 18.11 | Complementa D4.3 e D18.5. Enquanto o prazo está à frente, o `next_attempt_at` nunca passa de `created_at + 15 min`, inclusive no caminho de erro. Depois do prazo, um erro (transitório ou não) reagenda com o backoff normal: sem avaliar a referência, não dá para decidir. O não transitório continua contando para o `FAILED` (D18.4). A expiração acontece na primeira tentativa que conseguir avaliar. | A expiração depende de avaliar (D18.5); um erro impede a avaliação, não a adia para sempre. | Expirar no caminho de erro: rejeitaria uma transação cuja referência pode ter chegado. |
| 18.12 | Todo horário gravado vem do `now()` da transação no banco: `TransactionScope.now()`. Vale para a submissão (`created_at`, `processed_at`, eventos), o worker (prazo, backoff, `processed_at`, eventos), a abertura de wallet e a reconciliação. A porta `Clock` e o adaptador saem. | O claim e a cutucada já usam o `now()` do banco (D18.2); prazo e backoff calculados com outro relógio divergiam dele. Um relógio só para todas as instâncias. | Relógio da aplicação: cada instância com o seu, e o prazo contado num relógio diferente do claim. |
| 18.13 | Complementa D4.2 e D18.4. Pendente cuja wallet não existe (a FK impede; só com dado corrompido) vira `FAILED PROCESSING_FAILED` na primeira tentativa ou no primeiro erro, com `WagerTransactionFailed` (`orderingKey` = `wallet_id` da linha) e cutucada. Sem lock de wallet (não há o que travar); a linha é travada e o dono do lease é conferido. | Nenhuma tentativa vai resolver: esperar 5 erros só prolonga, e o registro do erro também falharia (o lease venceria a cada 30 s, para sempre). | Esperar os 5 erros: nunca chegaria a `FAILED`. |

---

## Encaixes para os extras (resumo)
Todo extra só **adiciona**:
- um assinante do SNS (WebSocket, S3, partidas dobradas, auditor);
- um adaptador de porta existente (`SecretsProvider`, `ProviderIdentityPort`);
- um perfil do Compose (observabilidade, frontend).

Se um extra exigir mudar uma tabela, um fluxo ou um teste do núcleo, ele volta para este documento como decisão nova.
