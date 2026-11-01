# wagering — HTTP

Controllers do `wagering` no processo `api`. Toda rota exige Bearer, menos health e `/docs` (D10). Documentação interativa em **`/docs`** (JSON em `/docs-json`, também aberto, D16.14), com corpo, respostas e status da D5 de cada endpoint (D13.2).

## Endpoints

| Método e rota | Papel (D10.2) | Sucesso | Erros |
|---|---|---|---|
| `POST /wallets` | `operator` | `201` `{ id, playerId, balance, version }` | `400`, `401`, `403`, `409 WALLET_ALREADY_EXISTS` (com `details.walletId`), `503` |
| `GET /wallets/:walletId` | `provider`, `operator` | `200` mesmo formato da criação | `400` (id não UUID, D16.8), `401`, `404`, `503` |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | `provider`, `operator` | `200` `{ items, nextCursor }` | `400` (cursor ou `limit` inválido), `401`, `404`, `503` |
| `POST /wallets/:walletId/reconciliation` | `operator` | `200` sempre, com `consistent` e `issues` | `400`, `401`, `403`, `404`, `503` |

Uma wallet não pertence a um provedor, então qualquer provedor a consulta (D10.2).

## Entrada

Validada com zod em `wallet.schemas.ts`, antes do use case. Falha → `400 VALIDATION_ERROR`, nada gravado (D5):
- `playerId`: 1 a 128 caracteres `[A-Za-z0-9._:-]` (D6.4);
- `initialBalance`: obrigatório (D6.7). O formato é do `Money.from`: 0 a 2 casas, sem sinal, até 12 dígitos inteiros, normalizado para 2 casas (D2.1, D2.2). A moeda é da lista configurada (D2.5, D14.7). Zero é aceito e não gera `OPENING` (D2.3);
- ledger: `limit` inteiro de 1 a 200, padrão 50; `cursor` só o que a API emitiu (D6.8).

Os detalhes do `400` levam só o caminho e a mensagem de cada problema, nunca o valor recebido.

## Saída

`wallet.presenter.ts` monta os contratos (R-09-04, R-09-18, D5). Dinheiro sempre `{ amount, currency }` com 2 casas. Item do ledger: `{ id, transactionId, direction, money, balanceBefore, balanceAfter, walletVersion, createdAt }`. Reconciliação: `{ walletId, storedBalance, calculatedBalance, difference, consistent, checkedEntries, issues }`, com `difference` = armazenado − calculado, com sinal (D2.6), e `issues` = `[{ code, walletVersion? }]` (D16.5).

`failure-code-http-status.ts`: `Record<FailureCode, HttpStatus>` (D5, D16.4): rejeições → `422`, `PROCESSING_FAILED` → `500`. Usado pela submissão de transações (S4).

## Testes

| Arquivo | Prova |
|---|---|
| `test/integration/wallets/create-wallet.spec.ts` | `201` com e sem `OPENING`, `version` 1, eventos na outbox em ordem, `409` com `walletId`, outra moeda, `400` sem gravar, correlação |
| `test/integration/wallets/query-wallet.spec.ts` | `GET` da wallet, ordem do ledger, `limit`, cursor estável: lançamentos gravados entre páginas aparecem na seguinte (D16.9), `400` e `404` |
| `test/integration/wallets/reconciliation.spec.ts` | consistente; saldo adulterado pelo papel dono → `consistent: false` com log e métrica; não corrige. O `CHAIN_BREAK` é provado no teste de unidade do `reconcileWallet` (o ledger não recebe `UPDATE`, nem em teste) |
| `test/integration/logging/sensitive-data.spec.ts` | nos caminhos que logam (divergência, `500`), nenhum valor, saldo, `playerId` nem token; o logger singleton é capturado (D11.1) |
| `test/concurrency/wallet-creation.spec.ts` | `POST` parado no índice único (por `pg_locks`): rival commita → `409` com o id dela; rival segura além do `lock_timeout` → `503` com `Retry-After: 1`; 20 em paralelo |
| `test/integration/auth/auth.spec.ts` | `401`, `403`, permissões por papel, health e `/docs` abertos, JSON mal formado sem token → `400` (D16.15) |
| `test/integration/auth/jwks-unavailable.spec.ts` | JWKS não-200, recusado ou sem resposta → `503` (D16.16) |
| `test/integration/docs/swagger.spec.ts` | todos os endpoints no Swagger, com os status da D5, o Bearer, o corpo de erro em toda resposta de erro e o `Retry-After` no `503` |
| `test/unit/http/failure-code-http-status.spec.ts` | status de cada `failureCode` |
