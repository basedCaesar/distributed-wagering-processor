# wagering — application

Use cases e portas. Não importa MikroORM, AWS SDK, pino nem `infra/` (o lint garante). Os adaptadores são escolhidos em [`infra/wagering.module.ts`](../infra/wagering.module.ts).

## Peças

| Arquivo | O que é | Regras |
|---|---|---|
| `ports.ts` | `UnitOfWork` (uma transação SQL por chamada, com os repositórios presos a ela), repositórios (inclusive `lockById` da wallet, as buscas de transação e, para o worker, `lockPending`, `resolve`, `reschedule` e `nudgeDependents`), `PendingQueue` (claim), `OutboxWriter`, `IdGenerator`, `Clock`, `ReconciliationMetrics`, `ReconciliationLog`, `SubmissionMetrics` (duplicatas por camada). | CLAUDE.md, D4.3, D4.4, D6.6, D7.2, D9, D16.6, D17.7, D18 |
| `open-wallet.use-case.ts` | Abre a wallet: wallet, `OPENING`, lançamento e eventos numa transação só. | R-09-02..05 · D6.2, D6.3, D9.4 |
| `submit-wager-transaction.use-case.ts` | Submissão de transação: o mesmo use case para HTTP e fila (R-10-03). Lock da wallet, idempotência autoritativa, regras do domínio, `balance_after`, outbox, cutucada das pendentes que esperam uma transação que ficou terminal. | R-07-*, R-08-*, R-09-10..17 · D1, D3, D4.1, D4.4, D7.2, D17 |
| `resolve-pending-transaction.use-case.ts` | Uma tentativa do worker sobre uma `PENDING_REFERENCE` (`attempt`) e o registro de um erro dela (`recordError`). | R-07-13, R-07-20..22 · D4, D18 |
| `pending-policy.ts` | Valores da D4.3/D18.2 e funções puras: backoff preso ao prazo, prazo esgotado, limite de erros. | D4.2, D4.3, D18.1, D18.2, D18.5 |
| `transaction-events.ts` | `eventsForTransition`: os eventos de uma transação que acabou de mudar de estado, o mesmo na submissão e no worker. | D4.6, D9.4 |
| `payload-hash.ts` | `canonicalJson` e `payloadHash` (algoritmo abaixo). | R-09-14 · D3.3 |
| `transaction-queries.ts` | `GET` de transação por id e por `(providerId, externalTransactionId)`, com o escopo do provedor. | R-09-08, R-09-09 · D6.1, D10.2 |
| `wallet-queries.ts` | `GET` da wallet e página do ledger. | R-09-06, R-09-07 · D6.8 |
| `reconcile-wallet.use-case.ts` | Reconciliação em `REPEATABLE READ`, sem lock; grava a execução; divergência → log + métrica. | R-09-18, R-09-19 · D6.9, D16.5, D16.6 |
| `ledger-cursor.ts` | Cursor opaco = base64url da última `walletVersion`. | D6.8 |
| `errors.ts` | `WalletAlreadyExistsError` (409 com `walletId`), `IdempotencyKeyConflictError` e `ExternalIdConflictError` (409 com `transactionId`), `InvalidSubmissionError` e `InvalidCursorError` (400), `WalletNotFoundError` e `TransactionNotFoundError` (404), `ConcurrentSubmissionError` (503, a repetição bateu de novo no índice), `DuplicateTransactionError` (barreira do índice, interna). | D3.6, D5, D6.3, D16.2, D17.2, D17.6 |

## Submeter uma transação

1. **Payload.** O controller valida o schema (`400`) e confere o `providerId` com o token (`403`). O use case monta a `WagerTransaction` só para validar o que depende do payload: kind, referência por kind, sinal do valor (`400`, D5). Nada é gravado.
2. **Checagem rápida**, só leitura, por `(providerId, key)`: replay de operação antiga sem pegar lock (D3.6).
3. **Transação SQL** (`READ COMMITTED`):
   - `SELECT … FOR UPDATE` na wallet (D7.2). Inexistente → `404`. Espera além do `lock_timeout` (2 s) → `503`;
   - checagem **autoritativa** da key, depois do lock: a duplicata simultânea espera o lock, vê a original já commitada e devolve replay (D3.6). Key com hash diferente → `409 IDEMPOTENCY_KEY_CONFLICT`. Id externo com outra key → `409 EXTERNAL_ID_CONFLICT` (D3.2, D17.2);
   - busca da referência e `alreadyReversed` (só reversões `PROCESSED` contam, D1.1, D1.3);
   - `applyWagerTransaction` decide `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE` (D4.1, D14.2);
   - grava a transação (com o `balance_after` e o `correlationId`), o lançamento e o saldo se mudou, e os eventos na outbox, todos com `orderingKey` = `walletId` (R-06-52, D9.3);
   - se a transação é terminal, "cutuca" as pendentes da mesma wallet que a referenciam: `next_attempt_at = now()`, com `SKIP LOCKED` (D4.4, D18.6).
4. **Barreira final:** se o commit violar o `UNIQUE` de key ou de id externo (a mesma key em outra wallet, que tem outro lock), a transação é desfeita e o use case repete **uma vez**. A segunda tentativa vê a vencedora e cai no replay ou no `409` (D3.6). Se ela bater de novo num `UNIQUE`, `503` com `Retry-After` (D17.6).

**Duplicatas por camada** (`wagering_duplicates_total{layer}`, D17.7): `fast_path` no passo 2, `lock` na checagem autoritativa do passo 3, `unique_index` no passo 4 (a repetição que vem depois não conta de novo). Duplicatas simultâneas na mesma wallet param no `lock`; se alguma chegar ao `unique_index`, a checagem saiu de baixo do lock.

Eventos: `PROCESSED` → `WagerTransactionProcessed` (+ `WalletBalanceChanged` se o saldo mudou; `LOSS` não muda); `REJECTED` → `WagerTransactionRejected`; `PENDING_REFERENCE` → `WagerTransactionPendingReference` (uma vez, D4.6). A pendente nasce vencida para o worker (D17.4); ver "Resolver uma pendente" abaixo.

**Replay** devolve o estado atual da transação gravada, com `idempotentReplay: true` e o status HTTP desse estado (D3.4). O saldo é o `balance_after` gravado, o observado na época (R-07-12, D3.5).

```mermaid
sequenceDiagram
    autonumber
    participant P as Provedor
    participant C as Controller
    participant U as SubmitWagerTransactionUseCase
    participant DB as PostgreSQL

    P->>C: POST /wagering/transactions + Idempotency-Key + Bearer
    C->>C: guard (401/403), zod (400), providerId = token (403)
    C->>U: execute(comando, correlationId)
    U->>U: payloadHash; WagerTransaction.create (400)
    U->>DB: SELECT por (provider, key) — só leitura
    alt key já existe
        DB-->>U: transação gravada
        U-->>C: replay (mesmo hash) ou 409
    else nova
        U->>DB: BEGIN; SELECT wallet FOR UPDATE
        Note over U,DB: duplicatas simultâneas esperam aqui (lock_timeout 2 s → 503)
        U->>DB: SELECT por (provider, key) e por (provider, externalId)
        alt já existe (outra requisição commitou)
            U-->>C: replay ou 409
        else
            U->>DB: SELECT referência + reversão PROCESSED dela
            U->>U: applyWagerTransaction (D14.2)
            U->>DB: UPDATE wallet, INSERT transação, lançamento, outbox
            U->>DB: COMMIT (triggers diferidos conferem)
            alt UNIQUE de key/id externo violado
                U->>U: repete uma vez → replay ou 409 (de novo → 503, D17.6)
            end
            U-->>C: transação + idempotentReplay false
        end
    end
    C-->>P: 200 PROCESSED · 202 PENDING_REFERENCE · 422 REJECTED
```

## Resolver uma pendente (R-07-13, R-07-20..22, D4, D18)

O worker ([`infra/workers/README.md`](../infra/workers/README.md)) pega um lote no claim e chama `attempt` para cada item, em ordem (D18.9). Cada tentativa é uma transação SQL:

1. trava a wallet, depois a linha (mesma wallet); se ela já não estiver pendente, outra instância resolveu → `skipped`;
2. busca a referência e chama `applyWagerTransaction`, a mesma regra da submissão (D14.2);
3. o resultado:
   - **ainda esperando, dentro do prazo:** `attempts + 1`, `consecutive_errors = 0`, `next_attempt_at` = `min(2^(attempts−1) s, 60 s)`, sem passar de `created_at + 15 min`. Sem evento (D4.6);
   - **ainda esperando, prazo esgotado:** `expirePendingReference` → `REJECTED REFERENCE_NOT_FOUND` (R-07-22). A avaliação vem antes da expiração: uma referência que chegou no fim do prazo é aplicada (D18.5);
   - **decidida:** `PROCESSED` (lançamento e saldo) ou `REJECTED`;
4. terminal: grava, emite (`correlationId` da submissão original, `causationId` = id da tentativa, D18.3) e cutuca as pendentes que esperam por ela, como a cadeia `BET ← REFUND ← ROLLBACK` (D18.6).

`recordError` roda numa transação própria depois que a tentativa foi desfeita: transitório → só `attempts + 1` e backoff; outro erro → `consecutive_errors + 1`. No 5º seguido, `FAILED PROCESSING_FAILED` com `WagerTransactionFailed` e cutucada (D4.2, D18.4). O replay de uma pendente resolvida devolve o estado novo (D3.4): `200`, `422` ou `500`.

## payloadHash (R-09-14, D3.3)

SHA-256, em hex, do **JSON canônico** destes campos: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId` (omitido se ausente).
- JSON canônico: chaves em ordem crescente (por code unit) em todos os níveis, sem espaços, `undefined` omitido.
- `money` vai normalizado para 2 casas (`"25"` → `"25.00"`, D2.1), então os dois são a mesma operação.
- Ficam de fora a key (é a identidade, não o conteúdo), o `messageId`, o `type` e o `occurredAt`. HTTP e fila geram o mesmo hash para a mesma operação.

Exemplo, o corpo do §9: `{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-…","providerId":"provider-a","roundId":"round-987","walletId":"0192f291-…"}`.

## Abrir uma wallet

1. O domínio (`openWallet`) monta a wallet com `version` 1 e, se o saldo for positivo, a `OPENING` `PROCESSED` com o lançamento v1 (D2.3, D6.2).
2. Eventos, nesta ordem: `WalletOpened`, e com saldo, `WagerTransactionProcessed` e `WalletBalanceChanged` (D6.2, D9.4). Todos com `orderingKey` = `walletId` e o `correlationId`/`causationId` da requisição (D9.3, D9.5).
3. Uma transação: wallet (com flush na hora), `OPENING`, lançamento, linhas da outbox (R-09-03).
4. **Sem pré-checagem de duplicata:** o `UNIQUE (player_id, currency)` é a única barreira. Quem perde a corrida (sequencial ou paralela) tem a transação desfeita e recebe `409 WALLET_ALREADY_EXISTS` com o id da wallet que ganhou (D6.3).

## Reconciliação

O cálculo é puro, no domínio (`domain/wallet-reconciliation.ts`): Σ créditos − Σ débitos, encadeamento e cauda (D6.9). O use case só lê no mesmo snapshot, grava a execução em `reconciliation_runs` e, se divergir, chama as portas de métrica e de log. O log leva `walletId`, os códigos das divergências e `checkedEntries`, **nunca** saldos nem a diferença (D11.1). Nada é corrigido.

## Testes

| Arquivo | Prova |
|---|---|
| `test/unit/application/ledger-cursor.spec.ts` | ida e volta do cursor; cursores inválidos |
| `test/unit/application/payload-hash.spec.ts` | vetor fixo do §9; chaves ordenadas em todos os níveis; ordem dos campos não importa (propriedade); `"25"` = `"25.00"`; cada campo de negócio muda o hash; key e metadados não |
| `test/unit/application/submit-wager-transaction.spec.ts` | barreira do `UNIQUE` com `UnitOfWork` em memória: a repetição vê a vencedora → replay, `unique_index` contado uma vez; bate de novo → `ConcurrentSubmissionError` (transitório, D17.6), sem 3ª tentativa; replay rápido conta `fast_path` |
| `test/unit/application/pending-policy.spec.ts` | valores da D4.3/D18.2; backoff 1, 2, 4 … 60 s; preso ao prazo; prazo de 15 min; 5º erro |
| `test/unit/application/resolve-pending-transaction.spec.ts` | ordem dos locks; reagendar, aplicar, expirar, expirar depois de avaliar (D18.5), `skipped`; `recordError` transitório, não transitório e 5º erro → `FAILED` |
| `test/integration/wagering/pending-worker.spec.ts` | worker real sobre Postgres: backoff e lease; prazo → `REFERENCE_NOT_FOUND` com evento e replay `422`; referência que chega depois do prazo; referência ainda pendente no prazo; cutucada (mesma wallet só, `BET` `REJECTED` também, cadeia `REFUND ← ROLLBACK`); 5 erros → `FAILED` e replay `500`; erros zerados; transitório não conta; replay `200` depois da resolução, com o `correlationId` original |
| `test/concurrency/pending-worker.spec.ts` | R-13-C7 (`REFUND` e `ROLLBACK` antes da `BET`, processo do worker rodando, já com backoff de 4 s → aplicado em < 2 s); duas reversões pendentes → a mais antiga vence (D18.9) e, com dois workers, só uma aplicada; claim pula as linhas travadas e respeita o lease; dois workers sobre 20 pendentes → conjuntos disjuntos; cutucada não espera linha travada; worker espera a wallet travada e relê |
| `test/integration/wagering/*.spec.ts` | submissão e consultas pela API real (ver o README do HTTP) |
| `test/concurrency/submit-transaction.spec.ts` | corridas forçadas no lock da wallet, sincronizadas por `pg_locks` (D17.5), contando só os waiters da wallet do teste e com prazo de 1,5 s, abaixo do `lock_timeout`: R-13-C1 (50 iguais, as 10 conexões do pool esperando o lock → 1 débito, 49 replays, `fast_path + lock = 49` e `unique_index = 0`, D17.7), R-13-C2 (§8: 100.00 e duas de 80.00 → 1 `PROCESSED`, 1 `INSUFFICIENT_FUNDS`, saldo 20.00, 1 `DEBIT`), `REFUND` e `ROLLBACK` da mesma `BET` → 1 `PROCESSED`, 1 `REFERENCE_ALREADY_REVERSED` (D1.1), R-13-C3 (wallet A travada, B conclui; mais um teste de fumaça com 10 wallets), mesma key em duas wallets (barreira do `UNIQUE` → `409`, `unique_index = 1`, nada na outbox), lock além do `lock_timeout` → `503` |
| `test/unit/domain/wallet-reconciliation.spec.ts` | cada código da D16.5; não corrige |
| `test/integration/wallets/*.spec.ts` | os use cases pela API real, Postgres real (ver o README do HTTP) |
| `test/concurrency/wallet-creation.spec.ts` | `POST` parado no `UNIQUE` atrás de uma transação crua (confirmado por `pg_locks`): ela commita → `409` com o id dela; ela segura além do `lock_timeout` → `503`. Mais 20 criações iguais em paralelo → 1×201, 19×409 com o mesmo `walletId` |
