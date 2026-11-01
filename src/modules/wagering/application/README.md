# wagering — application

Use cases e portas. Não importa MikroORM, AWS SDK, pino nem `infra/` (o lint garante). Os adaptadores são escolhidos em [`infra/wagering.module.ts`](../infra/wagering.module.ts).

## Peças

| Arquivo | O que é | Regras |
|---|---|---|
| `ports.ts` | `UnitOfWork` (uma transação SQL por chamada, com os repositórios presos a ela), repositórios, `OutboxWriter`, `IdGenerator`, `Clock`, `ReconciliationMetrics`, `ReconciliationLog`. | CLAUDE.md, D6.6, D9, D16.6 |
| `open-wallet.use-case.ts` | Abre a wallet: wallet, `OPENING`, lançamento e eventos numa transação só. | R-09-02..05 · D6.2, D6.3, D9.4 |
| `wallet-queries.ts` | `GET` da wallet e página do ledger. | R-09-06, R-09-07 · D6.8 |
| `reconcile-wallet.use-case.ts` | Reconciliação em `REPEATABLE READ`, sem lock; grava a execução; divergência → log + métrica. | R-09-18, R-09-19 · D6.9, D16.5, D16.6 |
| `ledger-cursor.ts` | Cursor opaco = base64url da última `walletVersion`. | D6.8 |
| `errors.ts` | `WalletAlreadyExistsError` (409 com `walletId`), `WalletNotFoundError` (404), `InvalidCursorError` (400). | D5, D6.3, D16.2 |

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
| `test/unit/domain/wallet-reconciliation.spec.ts` | cada código da D16.5; não corrige |
| `test/integration/wallets/*.spec.ts` | os use cases pela API real, Postgres real (ver o README do HTTP) |
| `test/concurrency/wallet-creation.spec.ts` | `POST` parado no `UNIQUE` atrás de uma transação crua (confirmado por `pg_locks`): ela commita → `409` com o id dela; ela segura além do `lock_timeout` → `503`. Mais 20 criações iguais em paralelo → 1×201, 19×409 com o mesmo `walletId` |
