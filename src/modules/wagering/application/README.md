# wagering — application

Use cases e portas. Não importa MikroORM, AWS SDK, pino nem `infra/` (o lint garante). Os adaptadores são escolhidos em [`infra/wagering.module.ts`](../infra/wagering.module.ts).

## Peças

| Arquivo | O que é | Regras |
|---|---|---|
| `ports.ts` | `UnitOfWork` (uma transação SQL por chamada, com os repositórios presos a ela), repositórios (inclusive `lockById` da wallet e as buscas de transação), `OutboxWriter`, `IdGenerator`, `Clock`, `ReconciliationMetrics`, `ReconciliationLog`. | CLAUDE.md, D6.6, D7.2, D9, D16.6 |
| `open-wallet.use-case.ts` | Abre a wallet: wallet, `OPENING`, lançamento e eventos numa transação só. | R-09-02..05 · D6.2, D6.3, D9.4 |
| `submit-wager-transaction.use-case.ts` | Submissão de transação: o mesmo use case para HTTP e fila (R-10-03). Lock da wallet, idempotência autoritativa, regras do domínio, `balance_after`, outbox. | R-07-*, R-08-*, R-09-10..17 · D1, D3, D4.1, D7.2, D17 |
| `payload-hash.ts` | `canonicalJson` e `payloadHash` (algoritmo abaixo). | R-09-14 · D3.3 |
| `transaction-queries.ts` | `GET` de transação por id e por `(providerId, externalTransactionId)`, com o escopo do provedor. | R-09-08, R-09-09 · D6.1, D10.2 |
| `wallet-queries.ts` | `GET` da wallet e página do ledger. | R-09-06, R-09-07 · D6.8 |
| `reconcile-wallet.use-case.ts` | Reconciliação em `REPEATABLE READ`, sem lock; grava a execução; divergência → log + métrica. | R-09-18, R-09-19 · D6.9, D16.5, D16.6 |
| `ledger-cursor.ts` | Cursor opaco = base64url da última `walletVersion`. | D6.8 |
| `errors.ts` | `WalletAlreadyExistsError` (409 com `walletId`), `IdempotencyKeyConflictError` e `ExternalIdConflictError` (409 com `transactionId`), `InvalidSubmissionError` e `InvalidCursorError` (400), `WalletNotFoundError` e `TransactionNotFoundError` (404), `DuplicateTransactionError` (barreira do índice, interna). | D3.6, D5, D6.3, D16.2, D17.2 |

## Submeter uma transação

1. **Payload.** O controller valida o schema (`400`) e confere o `providerId` com o token (`403`). O use case monta a `WagerTransaction` só para validar o que depende do payload: kind, referência por kind, sinal do valor (`400`, D5). Nada é gravado.
2. **Checagem rápida**, só leitura, por `(providerId, key)`: replay de operação antiga sem pegar lock (D3.6).
3. **Transação SQL** (`READ COMMITTED`):
   - `SELECT … FOR UPDATE` na wallet (D7.2). Inexistente → `404`. Espera além do `lock_timeout` (2 s) → `503`;
   - checagem **autoritativa** da key, depois do lock: a duplicata simultânea espera o lock, vê a original já commitada e devolve replay (D3.6). Key com hash diferente → `409 IDEMPOTENCY_KEY_CONFLICT`. Id externo com outra key → `409 EXTERNAL_ID_CONFLICT` (D3.2, D17.2);
   - busca da referência e `alreadyReversed` (só reversões `PROCESSED` contam, D1.1, D1.3);
   - `applyWagerTransaction` decide `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE` (D4.1, D14.2);
   - grava a transação (com o `balance_after` e o `correlationId`), o lançamento e o saldo se mudou, e os eventos na outbox, todos com `orderingKey` = `walletId` (R-06-52, D9.3).
4. **Barreira final:** se o commit violar o `UNIQUE` de key ou de id externo (a mesma key em outra wallet, que tem outro lock), a transação é desfeita e o use case repete **uma vez**. A segunda tentativa vê a vencedora e cai no replay ou no `409` (D3.6).

Eventos: `PROCESSED` → `WagerTransactionProcessed` (+ `WalletBalanceChanged` se o saldo mudou; `LOSS` não muda); `REJECTED` → `WagerTransactionRejected`; `PENDING_REFERENCE` → `WagerTransactionPendingReference` (uma vez, D4.6). A pendente nasce vencida para o worker (D17.4); a "cutucada" e o worker são da S5.

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
                U->>U: repete uma vez → replay ou 409
            end
            U-->>C: transação + idempotentReplay false
        end
    end
    C-->>P: 200 PROCESSED · 202 PENDING_REFERENCE · 422 REJECTED
```

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
| `test/integration/wagering/*.spec.ts` | submissão e consultas pela API real (ver o README do HTTP) |
| `test/concurrency/submit-transaction.spec.ts` | corridas forçadas no lock da wallet, sincronizadas por `pg_locks` (D17.5): R-13-C1 (50 iguais, as 10 conexões do pool esperando o lock → 1 débito, 49 replays), R-13-C2 (§8: 100.00 e duas de 80.00 → 1 `PROCESSED`, 1 `INSUFFICIENT_FUNDS`, saldo 20.00, 1 `DEBIT`), R-13-C3 (wallet A travada, B conclui; 10 wallets em paralelo), mesma key em duas wallets (barreira do `UNIQUE` → `409`), lock além do `lock_timeout` → `503` |
| `test/unit/domain/wallet-reconciliation.spec.ts` | cada código da D16.5; não corrige |
| `test/integration/wallets/*.spec.ts` | os use cases pela API real, Postgres real (ver o README do HTTP) |
| `test/concurrency/wallet-creation.spec.ts` | `POST` parado no `UNIQUE` atrás de uma transação crua (confirmado por `pg_locks`): ela commita → `409` com o id dela; ela segura além do `lock_timeout` → `503`. Mais 20 criações iguais em paralelo → 1×201, 19×409 com o mesmo `walletId` |
