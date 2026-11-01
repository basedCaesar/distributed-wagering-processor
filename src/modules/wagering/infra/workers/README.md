# wagering — workers

Processos de fundo do contexto `wagering`. Mesma imagem, entrypoints diferentes (D7.4).

## pending-worker (R-07-20..22, D4.3, D18)

Resolve as transações `PENDING_REFERENCE`. Entrypoint: `src/entrypoints/main-pending-worker.ts`; módulo raiz: `src/app/pending-worker.module.ts` (sem HTTP).

| Arquivo | O que é |
|---|---|
| `pending-worker.ts` | O laço. Cada instância tem um `leaseToken` (UUIDv7), o dono dos leases dela (D18.10). A cada tick de 1 s: claim de até 10 com lease de 30 s, depois uma tentativa por item, em ordem. Com o lote cheio, vai direto para o próximo lote, sem esperar o tick. `runOnce()` faz um lote só (é o que os testes usam); `start()`/`stop()` controlam o laço. |
| `pending-worker.module.ts` | Liga o use case, o claim e o laço; no shutdown, para o laço antes de o ORM fechar. |

Fluxo de um item:
1. **Claim** (`infra/persistence/pending-queue.ts`): uma transação curta e commitada, com `SKIP LOCKED`; grava o lease e o dono (`locked_by` = token). Nunca é segurado enquanto a wallet é travada (CLAUDE.md).
2. **Tentativa** (`ResolvePendingTransactionUseCase.attempt`): trava a wallet, trava a linha, relê, confere o dono, aplica. Detalhe em [`application/README.md`](../../application/README.md#resolver-uma-pendente-r-07-13-r-07-2022-d4-d18).
3. **Erro**: passa por `classifyError()`. Transitório → só backoff; outro → conta; no 5º seguido, `FAILED` (D18.4). Se nem o registro do erro der certo (banco fora), o lease vence e outra rodada tenta.

Garantias:
- **Dois workers não processam a mesma pendente:** `SKIP LOCKED` no claim, o lease e o dono do lease (D18.10). Se o lease vencer com o item ainda em processamento (o lote esperando locks) e outro worker reclamar a linha, o primeiro, ao travar a wallet e a linha, vê que `locked_by` já não é o token dele e pula (`skipped`), sem contar tentativa nem erro. Se a linha já for terminal, também pula.
- **Sem deadlock:** a ordem de locks é sempre wallet → linhas da mesma wallet. A cutucada usa `SKIP LOCKED`.
- **Sem cutucada perdida:** a decisão "continua pendente" e a gravação da referência acontecem sob o mesmo lock da wallet. Ou o worker já vê a referência, ou a cutucada dela vem depois do reagendamento.
- **Duas reversões esperando a mesma referência:** só uma é aplicada, entre quaisquer workers (D1.1, D1.3): a segunda vê a primeira sob o lock da wallet e vira `REFERENCE_ALREADY_REVERSED`. Qual delas vence só é determinístico **dentro do lote de um worker**: a cutucada põe o mesmo `now()` nas duas, o claim desempata por `created_at`, e a mais antiga vence (D18.9). Com dois workers, ou com as duas em lotes diferentes, vence a que travar a wallet primeiro.
- **Relógio único:** prazo, backoff e horários gravados vêm do `now()` da transação no banco, o mesmo do claim (D18.12).

`SIGTERM`/`SIGINT`: termina o item atual e fecha; os leases dos outros vencem sozinhos (D8.6, D18.8). O teste de `SIGTERM` é da S8.

Logs: `transactionId` e `walletId` no contexto; a categoria e o código do erro. Nunca valores, saldos nem payload (D11.1).

## Testes

- `test/integration/wagering/pending-worker.spec.ts` e `test/concurrency/pending-worker.spec.ts`: ver a tabela em [`application/README.md`](../../application/README.md#testes).
- `test/support/worker.ts`: `startTestWorker()` monta o worker sobre um MikroORM próprio (duas chamadas = duas instâncias, D18.7), com injeção opcional de falha na unidade de trabalho. `startNestWorker()` sobe o processo como o entrypoint monta. `parkPendings()`: ao fim de cada teste, as pendentes que ele criou vencem só daqui a um dia. O banco de teste não é limpo entre rodadas, e pendentes vencidas de um teste virariam backlog do próximo. `parkAllPendings()`: estaciona todas as pendentes do banco, de qualquer arquivo; o R-13-C7 chama antes de medir o tempo com o worker em laço.
