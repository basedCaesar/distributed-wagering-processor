# wagering — workers

Processos de fundo do contexto `wagering`. Mesma imagem, entrypoints diferentes (D7.4).

## pending-worker (R-07-20..22, D4.3, D18)

Resolve as transações `PENDING_REFERENCE`. Entrypoint: `src/entrypoints/main-pending-worker.ts`; módulo raiz: `src/app/pending-worker.module.ts` (sem HTTP).

| Arquivo | O que é |
|---|---|
| `pending-worker.ts` | O laço. A cada tick de 1 s: claim de até 10 com lease de 30 s, depois uma tentativa por item, em ordem. Com o lote cheio, vai direto para o próximo lote, sem esperar o tick. `runOnce()` faz um lote só (é o que os testes usam); `start()`/`stop()` controlam o laço. |
| `pending-worker.module.ts` | Liga o use case, o claim e o laço; no shutdown, para o laço antes de o ORM fechar. |

Fluxo de um item:
1. **Claim** (`infra/persistence/pending-queue.ts`): uma transação curta e commitada, com `SKIP LOCKED`. Nunca é segurado enquanto a wallet é travada (CLAUDE.md).
2. **Tentativa** (`ResolvePendingTransactionUseCase.attempt`): trava a wallet, trava a linha, relê, aplica. Detalhe em [`application/README.md`](../../application/README.md#resolver-uma-pendente-r-07-13-r-07-2022-d4-d18).
3. **Erro**: passa por `classifyError()`. Transitório → só backoff; outro → conta; no 5º seguido, `FAILED` (D18.4). Se nem o registro do erro der certo (banco fora), o lease vence e outra rodada tenta.

Garantias:
- **Dois workers não pegam a mesma pendente:** `SKIP LOCKED` no claim e o lease. Se o lease vencer com o item ainda em processamento, a releitura sob o lock da wallet impede um segundo efeito: a linha já estará terminal (`skipped`).
- **Sem deadlock:** a ordem de locks é sempre wallet → linhas da mesma wallet. A cutucada usa `SKIP LOCKED`.
- **Sem cutucada perdida:** a decisão "continua pendente" e a gravação da referência acontecem sob o mesmo lock da wallet. Ou o worker já vê a referência, ou a cutucada dela vem depois do reagendamento.
- **Duas reversões esperando a mesma referência:** a cutucada põe o mesmo `now()` nas duas; o claim desempata por `created_at`, e a mais antiga vence (D1.3, D18.9).

`SIGTERM`/`SIGINT`: termina o item atual e fecha; os leases dos outros vencem sozinhos (D8.6, D18.8). O teste de `SIGTERM` é da S8.

Logs: `transactionId` e `walletId` no contexto; a categoria e o código do erro. Nunca valores, saldos nem payload (D11.1).

## Testes

- `test/integration/wagering/pending-worker.spec.ts` e `test/concurrency/pending-worker.spec.ts`: ver a tabela em [`application/README.md`](../../application/README.md#testes).
- `test/support/worker.ts`: `startTestWorker()` monta o worker sobre um MikroORM próprio (duas chamadas = duas instâncias, D18.7), com injeção opcional de falha na unidade de trabalho. `startNestWorker()` sobe o processo como o entrypoint monta. `parkPendings()`: ao fim de cada teste, as pendentes que ele criou vencem só daqui a um dia. O banco de teste não é limpo entre rodadas, e pendentes vencidas de um teste virariam backlog do próximo.
