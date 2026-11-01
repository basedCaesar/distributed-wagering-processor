# CLAUDE.md

Instruções para agentes de IA neste repositório. Leia inteiro antes de qualquer tarefa.

## O projeto

Processador distribuído de transações de apostas (desafio de backend da Jungle Gaming). Recebe `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` por HTTP e por SQS. Mantém saldo e ledger corretos com mensagens duplicadas, fora de ordem e processadas por várias instâncias ao mesmo tempo. O que é avaliado é **correção financeira, concorrência e idempotência**.

## Fontes da verdade, em ordem de precedência

| Arquivo | Papel |
|---|---|
| `docs/CHALLENGE.md` | O enunciado. **Manda.** |
| `docs/01-requisitos.md` | Requisitos com ID (`R-xx-yy`), citados literalmente do enunciado. Congelado. |
| `docs/02-decisoes.md` | Decisões aprovadas (`D1`..`D12`, itens `1.1`, `3.6`...). |
| `docs/03-plano.md` | Fatias, critérios de aceite e checklist. **Uma fatia por vez.** |

- Nunca mude uma decisão por conta própria. Se achar que uma está errada ou que falta uma, **pare e explique**, citando o ID.
- Se algo não estiver decidido, não escolha em silêncio: aponte o requisito e proponha uma decisão nova.

**Regra do avaliador:** os exemplos do enunciado funcionam como estão escritos:
- os `curl` do §9, com o header `Authorization` (D10.3);
- a mensagem do §10 enviada com `awslocal sqs send-message --message-group-id …`, **sem atributos extras** (D8.1).

## Stack

Bun 1.x · TypeScript `strict` · NestJS · MikroORM (`EntitySchema`) · PostgreSQL · LocalStack (SQS FIFO, SNS FIFO) · Docker Compose + nginx · Keycloak + `jose` · zod · `@nestjs/swagger` · pino · prom-client · fast-check · Biome.

Processos (D7.4), mesma imagem, entrypoints diferentes:

| Processo | Instâncias |
|---|---|
| `api` | 3 |
| `consumer` | 3 |
| `outbox-publisher` | 2 |
| `pending-worker` | 2 |
| `event-auditor` | 1 |

## Ambiente de desenvolvimento

- Windows + Docker Desktop (backend WSL2). O Claude Code roda os comandos no Git Bash.
- Todo arquivo de texto usa fim de linha **LF** (`.gitattributes`). Um script `.sh` com CRLF quebra quando roda dentro de um container (por exemplo, o init do LocalStack).
- Os scripts do `package.json` precisam funcionar no Windows e no Linux. Use Bun ou TypeScript para scripts; use bash só para o que roda dentro de containers ou no Git Bash.
- O `awslocal` roda **dentro** do container do LocalStack: `docker compose exec localstack awslocal …`. Não depende de Python instalado na máquina.

## Estrutura

```
src/entrypoints/main-{api,consumer,outbox-publisher,pending-worker,event-auditor}.ts
src/app/                     um módulo raiz por processo
src/shared/                  config, logger, métricas, ORM, clientes AWS, auth, classifyError
src/modules/<contexto>/
    domain/                  TypeScript puro
    application/             use cases e portas
    infra/                   persistência, HTTP, mensageria, workers
migrations/
test/{unit,integration,concurrency,e2e}/
proofs/                      patches que removem uma proteção
scripts/acceptance.sh        roda os exemplos do §9 e do §10 literalmente
```

## Regras invioláveis

**Dinheiro (D2)**
- Nunca `number`, `float` ou `double` para dinheiro.
- `Money` guarda centavos em `bigint`. No banco: `numeric(20,2)` + `char(3)`, lidos como string.
- No domínio são proibidos `Number(`, `parseFloat`, `parseInt`, `Math.*` e `toFixed`.
- Entrada:
  - 0 a 2 casas, até 12 dígitos inteiros, normalizada para 2 casas antes de tudo;
  - nada é arredondado;
  - valor > 0, exceto `LOSS`, que aceita ≥ 0;
  - moedas da lista configurada (`BRL`, `USD`).
- Negativo só é proibido na fábrica de entrada (`Money.from`).

**Camadas**
- `domain/` não importa NestJS, MikroORM, AWS SDK, pino, zod, `application/` nem `infra/`.
- `application/` não importa MikroORM, AWS SDK, pino nem `infra/`.
- O lint garante isso. **Nunca desative uma regra do lint para o código passar.**

**Transações e concorrência (D3, D4, D7)**
- Toda escrita financeira acontece numa única transação SQL, aberta pelo use case: transação, saldo, ledger, inbox, outbox e "cutucada" de pendentes.
- **Ordem de locks:**
  1. chave da inbox (só o consumidor);
  2. wallet (`PESSIMISTIC_WRITE`);
  3. linhas de transação da **mesma** wallet.

  Claims do worker e do publisher são transações curtas e commitadas, com `SKIP LOCKED`. Nunca segure o claim enquanto trava uma wallet.
- A checagem autoritativa de idempotência acontece **depois** do lock da wallet.
- A `version` sobe uma vez por mudança de saldo, por **um** mecanismo só (D7.2).
- Sem lock global. Sem cache em memória como garantia.
- `lock_timeout` 2 s, `statement_timeout` 5 s, requisição 10 s (D5).

**Regras de negócio (D1, D4, D5)**
- Uma reversão `PROCESSED` por referência, de qualquer tipo.
- Toda referência precisa estar `PROCESSED`:
  - se estiver pendente, espera;
  - se for terminal sem ser `PROCESSED`, `REFERENCE_NOT_PROCESSED`.
- `PENDING` nunca é gravado.
- `FAILED` só é gravado pelo worker.
- Fronteira de erro:
  - decidível só pelo payload → `400`, não grava;
  - depende do banco → `REJECTED` gravado;
  - wallet inexistente → `404`.

**HTTP (D5)**

| Situação | Status |
|---|---|
| `PROCESSED` | `200` |
| wallet criada | `201` |
| `PENDING_REFERENCE` | `202` |
| payload inválido | `400` |
| sem token / sem permissão | `401` / `403` |
| não encontrado (ou de outro provedor) | `404` |
| conflito | `409` |
| `REJECTED` | `422` |
| transitório | `503` + `Retry-After` |

- Replay devolve o estado atual da transação, com `idempotentReplay: true`.
- Todo `failureCode` tem status num `Record<FailureCode, HttpStatus>`.

**Mensageria (D3, D8, D9)**
- Use cases nunca publicam: eventos viram linhas da outbox.
- O envelope é exatamente o do §11.
- HTTP e consumidor chamam **o mesmo** use case.
- Ack só depois do commit.
- Inbox por `(consumer_name, messageId do corpo)`.
- Permanente → a cópia vai para a DLQ com corpo e atributos intactos.
- Tentativas contadas em `message_attempts`, nunca pelo `ApproximateReceiveCount`.
- O publisher nunca descarta um evento.
- Eventos de uma wallet saem em ordem.

**Segurança (D10)**
- A identidade vem do token.
  - Na submissão, o `providerId` do corpo tem que ser o do token, senão `403`.
  - Nas consultas, o que é de outro provedor responde `404`.
- **Não existe chave para desligar a autenticação.** Os testes usam o emissor de teste.
- Health e `/docs` (Swagger, D13.2) abertos. Fila sem auth.
- Nenhum segredo real no repositório.

**Banco (D7.3)**
- Invariantes do §6 são constraints e triggers, não só código.
- Ledger é append-only. Nunca `UPDATE`, `DELETE` ou `TRUNCATE` nele.
- A aplicação conecta com um papel sem esses privilégios. Nunca aumente privilégios para "resolver" um erro.
- Migration aplicada nunca é editada: crie outra.

**Logs (D11)**
- Nunca logar valores, saldos, payloads, `Authorization` ou `playerId`.

## Regras de trabalho

- **Planeje antes de codar.** Apresente o plano da fatia e espere aprovação.
- **Edite arquivos só com as ferramentas de edição** (Edit/Write). Nunca com `sed -i`, `bun -e`, `node -e`, `python` ou heredoc: isso pede aprovação manual a cada vez e esconde a mudança do diff de revisão.
- **Não comece comandos com `cd`**: você já está na raiz do projeto. Rode um comando por vez, sem encadear muitos com `&&`, `;` ou laços `for`, a não ser que seja necessário (por exemplo, as rodadas de 10×).
- **Testes primeiro.** O nome do teste cita o requisito e/ou a decisão: `it("R-13-C1 D3.6: 50 BETs iguais em paralelo → 1 débito")`.
- Testes de integração usam Postgres e LocalStack **reais**, com o papel da aplicação. Nunca mocke banco ou fila neles.
- Concorrência:
  - paralelismo real;
  - processos separados quando o requisito pede instâncias;
  - sincronização por estado observável (`pg_locks`), nunca por `sleep`.
- Todo teste que move dinheiro termina com `expectLedgerMatchesBalances()`.
- **Nunca altere um teste para ele passar.** Se o teste parece errado, pare e explique.
- Todo erro passa por `classifyError()`. Nada de `catch` genérico que engole erro.
- Commits pequenos: `tipo(escopo): descrição [R-xx D-y.z]`.

## Comandos

```bash
bun run infra:up          # Compose completo
bun run infra:test:up     # infraestrutura dos testes
bun run check             # typecheck + lint + unit + integração + concorrência
bun run test:proofs       # remove proteções e exige que os testes falhem
bun run migration:verify  # up → down → up
bun run acceptance        # exemplos do §9 e do §10, literalmente
```

## Definição de pronto de uma fatia

1. Critérios de aceite da fatia (`docs/03-plano.md`) atendidos.
2. `bun run check` verde. Testes de concorrência verdes em 10 execuções seguidas.
3. Diff revisado com o checklist do plano.
4. Se a IA errou e foi corrigida na fatia, o caso entra no `AI_WORKFLOW.md`.
5. README.md da parte criada ou alterada atualizado, com o diagrama Mermaid previsto na D13.4 para a fatia, e endpoints novos documentados no Swagger (D13).
