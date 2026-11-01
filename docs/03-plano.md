# 03 — Plano do núcleo

Fatias pequenas, uma por vez. Cada fatia lista o que entrega, os requisitos (`R-…`) e as decisões (`D…`) que cobre, e o critério de aceite. Ao fim do núcleo: tag `v1.0-core`.

## Calendário

| Dia | Fatias |
|---|---|
| Qui 29/10 | S0, S1 |
| Sex 30/10 | S2, S3 |
| Sáb 31/10 | S4, S5 |
| Dom 01/11 | S6, S7 |
| Seg 02/11 | S8, S9, S10 → `v1.0-core` |
| Ter 03 – Qua 04/11 | extras, um de cada vez, com decisão aprovada antes (`02-decisoes.md`, "Encaixes") |
| Qui 05/11 | folga, revisão, ensaio da apresentação |

Se atrasar, os extras encolhem. O núcleo não.

## Ciclo de cada fatia

1. **Plano.** O agente propõe o plano da fatia (arquivos, testes, ordem). Você revisa.
2. **Testes.** Testes dos requisitos da fatia primeiro, falhando.
3. **Implementação.**
4. **Check.** `bun run check` verde.
5. **Revisão.** Você revisa o diff com o checklist abaixo.
6. **Commit.** Mensagem citando os IDs.

**Prompt base:**

> Leia CLAUDE.md, docs/02-decisoes.md e a fatia Sx de docs/03-plano.md. Apresente o plano da fatia: arquivos, testes (com IDs) e ordem. Não escreva código antes da minha aprovação. Se encontrar algo não decidido ou conflitante, pare e aponte.

## Checklist de revisão do diff

- [ ] Algum `number` tocando dinheiro? Algum import proibido em `domain/` ou `application/`?
- [ ] Toda escrita financeira está numa transação só, aberta pelo use case?
- [ ] A ordem de locks é inbox → wallet → transações da mesma wallet?
- [ ] O ack e a publicação acontecem só depois do commit?
- [ ] Algum `catch` engole erro? Todo erro passa por `classifyError()`?
- [ ] Algum log com valor, saldo, payload, `playerId` ou token?
- [ ] Os testes usam banco e fila reais? Algum `sleep` sincronizando teste?
- [ ] `bun run test:repeat concurrency 10` verde? (salva o log de cada falha em `logs/test-repeat/`)
- [ ] Algum teste foi alterado só para passar?
- [ ] Alguma regra nova que não está em `02-decisoes.md`?
- [ ] README da parte, diagrama da fatia e Swagger atualizados (D13)?

---

## S0 — Fundação

**Entrega:**
- repositório com Bun, NestJS, `tsconfig` estrito e Biome, incluindo as regras de pureza do `domain/` e da `application/`;
- configuração validada com zod (inclui a lista de moedas, D2.5);
- porta `SecretsProvider` com adaptador de variável de ambiente, de onde saem as credenciais do banco (D12.3);
- logger pino com contexto via `AsyncLocalStorage`, ainda sem métricas;
- Compose com Postgres e LocalStack, e um script de init que cria:
  - `wager-transactions.fifo` (deduplicação por conteúdo);
  - `wager-transactions-dlq.fifo`, com redrive `maxReceiveCount = 20`;
  - `wagering-events.fifo` (SNS) e a fila assinante;
- infraestrutura separada para os testes;
- `/health/live` e `/health/ready`;
- `bun run check`;
- esqueleto de `scripts/acceptance.sh`.

**Cobre:** R-04-01..07, R-09-20..22, R-12-04 · D2.5, D11.3, D12.3

**Aceite:**
- `bun run check` verde num teste trivial;
- o lint falha se o `domain/` importar `@nestjs/*`;
- a readiness fica falsa com Postgres/LocalStack inalcançáveis (porta sem serviço e host não roteável) (teste de integração).

## S1 — Domínio puro

**Entrega:**
- `Money`;
- `Wallet` (com `open`, `debit` e `credit` devolvendo o lançamento);
- `WagerTransaction` com as transições;
- `WalletLedgerEntry`;
- o serviço de domínio que aplica as regras por kind e de referência;
- `FailureCode`;
- as classes de evento (envelope abstrato e subclasses);
- `README.md` de `src/shared/` (config, secrets, logger, health) e da infraestrutura, que ficaram da S0; `README.md` do domínio com o diagrama de estados da transação (D13).

**Cobre:** R-06-*, R-07-*, R-11-08..12, R-13-U1..U5 · D1, D2, D4.5, D5 (códigos), D6.2, D6.5, D9.4

**Aceite:**
- testes unitários e de propriedade (fast-check) para:
  - `Money`, incluindo "sem arredondamento";
  - as invariantes da `Wallet`;
  - as regras de cada kind;
  - todos os casos da D1: dupla reversão, `ROLLBACK` de `REFUND`, referência não processada, `WIN` de `BET` rejeitada;
  - conflito de moeda;
  - a key com payload divergente (o `matchesPayload`);
- o invariante saldo = soma dos lançamentos devolvidos vale em todos os testes que movem dinheiro;
- nenhum import de framework.

## S2 — Schema e persistência

**Entrega:**
- migrations para:
  - wallets, transações, ledger, inbox, outbox, `message_attempts` e execuções de reconciliação;
  - todas as garantias da D7.3: unicidades, `CHECK`s, triggers de imutabilidade, encadeamento e cauda diferida, FK composta da referência;
  - os papéis do banco;
- mapeamento MikroORM (`EntitySchema` e mappers);
- tipo `Money`;
- `bun run migration:verify`;
- diagrama do modelo de dados (D13.4).

**Contratos do domínio (S1):** A version só sobe dentro de Wallet.debit/credit; o mapeamento do ORM não pode incrementá-la (D7.2, D14). Coluna failure_detail (D14.3).

**Cobre:** R-04-07, R-05-05, R-05-09, R-13-I1 · D6.1, D7.1, D7.3

**Aceite:**
- um teste de integração **por garantia**, todos rodando com o papel da aplicação. Cada um tenta violar a garantia por SQL direto e espera o erro do banco:
  - saldo negativo;
  - `UPDATE` no ledger;
  - lançamento furado;
  - saldo sem lançamento no commit;
  - duas reversões `PROCESSED`;
  - duas wallets iguais;
  - `OPENING` com provedor.
- up → down → up funciona.

## S3 — Wallets e autenticação base

**Entrega:**
- `POST /wallets`, com `OPENING`, lançamento e eventos na mesma transação;
- `GET /wallets/:id`;
- `GET /wallets/:id/ledger` com cursor;
- `POST /wallets/:id/reconciliation`;
- o guard de autenticação com o `ProviderIdentityPort` e o emissor de teste, e o helper de teste que gera tokens;
- o mapeamento de erros para HTTP;
- Swagger em `/docs` com todos os endpoints existentes, incluindo health (D13.2).

**Cobre:** R-09-02..07, R-09-18..19, R-02-* · D5, D6.2–6.4, D6.7–6.9, D10.1–10.4

**Aceite:**
- criar wallet e depois criar de novo → `409` com o `walletId`;
- `version: 1` com e sem `OPENING`;
- o cursor é estável: lançamentos gravados entre duas páginas aparecem na página seguinte, sem duplicata nem furo (D16.9);
- uma reconciliação com divergência injetada por SQL (pelo papel dono) volta `consistent: false`, com log e métrica;
- `401` sem token; `403` com papel errado; health sem token.

## S4 — Submissão de transação (HTTP)

**Entrega:**
- `SubmitWagerTransactionUseCase`:
  - lock da wallet;
  - idempotência autoritativa;
  - regras de negócio;
  - `balance_after`;
  - linhas da outbox;
- `POST /wagering/transactions`;
- as consultas de transação;
- diagrama de sequência do processamento de uma transação (D13.4).

**Contratos do domínio (S1):** A busca da referência calcula alreadyReversed como 'existe reversão PROCESSED dela, de qualquer tipo' (D1.1).

**Contratos da persistência (S2):** o repositório grava o correlationId da submissão (D9.5). Ele não está na entidade: o repositório o recebe junto ao salvar e o passa ao `wagerTransactionToRecord`; a coluna é imutável depois do `INSERT`.

**Cobre:** R-07-*, R-08-*, R-09-08..17, R-13-C1..C3 · D1, D3.1–3.6, D5, D10.2

**Aceite:**
- R-13-C1: 50 requisições iguais em paralelo → 1 débito e 49 replays;
- R-13-C2: o cenário do §8, saldo 100 e duas apostas de 80;
- R-13-C3: wallets diferentes processadas em paralelo;
- mesma key com payload diferente → `409`; outra key com o mesmo id externo → `409`;
- replay devolve o mesmo corpo e o mesmo status;
- `providerId` de outro token → `403`; consulta de outro provedor → `404`;
- `"25"` e `"25.00"` → replay, não conflito.

## S5 — Referências fora de ordem

**Entrega:**
- `PENDING_REFERENCE`;
- `pending-worker`: claim com lease, backoff, prazo de 15 min, `FAILED` depois de 5 erros;
- a "cutucada" das pendentes da mesma wallet.

**Cobre:** R-07-13, R-07-20..22, R-13-C7 · D4

**Aceite:**
- R-13-C7: `REFUND` antes da `BET` → `202`, e depois a `BET` → o `REFUND` é aplicado em cerca de 1 s;
- prazo esgotado → `REJECTED` com `REFERENCE_NOT_FOUND` e evento;
- duas reversões pendentes da mesma `BET` → só uma é aplicada;
- dois workers não processam a mesma pendente;
- o replay de uma pendente resolvida devolve o estado novo.

## S6 — Consumidor SQS

**Entrega:**
- o processo `consumer`:
  - inbox;
  - classificação de erros;
  - cópia para a DLQ;
  - `message_attempts`;
  - backoff por visibilidade;
  - `SIGTERM`;
- diagrama do ciclo da mensagem SQS (D13.4).

**Cobre:** R-10-*, R-13-I3, R-13-I5, R-13-C5 · D3.7, D3.8, D8

**Aceite:**
- a mensagem do §10, enviada **exatamente** como está (só com `--message-group-id`), é processada;
- a mesma mensagem duas vezes → um efeito;
- permanente → DLQ na hora, com corpo e atributos intactos;
- transitório (Postgres parado) → retries e depois DLQ;
- R-13-C5: o processo morto depois do commit e antes do ack → a reentrega não duplica;
- `SIGTERM` durante o processamento termina ou devolve a mensagem.

## S7 — Outbox, SNS e auditor

**Entrega:**
- `outbox-publisher`: claim com lease, ordem por wallet, backoff, nunca descarta;
- `event-auditor` com deduplicação por `eventId`;
- diagrama da outbox com queda do processo (D13.4).

**Cobre:** R-11-*, R-13-I2, R-13-I4, R-13-C6, R-05-04 · D9

**Aceite:**
- R-13-I2: falha forçada depois de gravar o ledger → nada fica gravado, nem outbox, nem inbox;
- R-13-C6: dois publishers sobre a mesma outbox → cada evento sai uma vez em condições normais;
- evento publicado duas vezes → o auditor aplica uma vez;
- o processo morto depois do commit e antes de publicar → outra instância publica;
- os eventos de uma wallet chegam em ordem de `walletVersion`;
- nenhum evento é publicado antes do commit (teste com a transação ainda aberta).

## S8 — Instâncias, falhas e provas

**Entrega:**
- topologia do Compose (nginx, `api` ×3, `consumer` ×3, `publisher` ×2, `worker` ×2, auditor);
- `SIGTERM` em todos os processos;
- prazo de 10 s por requisição (D5), com teste;
- testes de falha;
- `bun run test:proofs`;
- diagrama da visão geral dos processos (D13.4).

**Cobre:** R-05-08, R-08-06, R-13-C4, R-13-C8, R-13-I6 · D7.4, D8.6

**Aceite:**
- R-13-C4: 3 processos separados com carga simultânea na mesma wallet → invariantes válidas;
- R-13-C8: reinício no meio da carga → consistência final verificada pela reconciliação de todas as wallets;
- **provas**: cada patch remove uma proteção e um teste nomeado **falha**:
  - o `FOR UPDATE`;
  - o índice de reversão;
  - o `CHECK` de saldo;
  - o trigger do ledger;
  - o `SKIP LOCKED`;
  - o ack antes do commit;
  - a inbox;
  - o trigger de cauda;
  - o papel restrito.

## S9 — Observabilidade

**Entrega:**
- os campos de log e a redação (D11.1);
- todas as métricas da D11.2, em `/metrics` (`wagering_duplicates_total{layer}` já é contada desde a S4, D17.7);
- métrica e log `refund_after_settlement` quando um `REFUND` atinge uma `BET` já liquidada, sem bloquear (D1.7; adiado da S4).

**Cobre:** R-12-01..03 · D11.1, D11.2, D1.7

**Aceite:**
- um teste captura os logs de um fluxo HTTP e de um SQS e verifica:
  - que os campos obrigatórios estão presentes;
  - que não aparece nenhum valor, saldo, `playerId` ou token;
- um teste dispara cada situação e confere que a métrica correspondente mudou.

## S10 — Keycloak, documentação e aceitação

**Entrega:**
- Keycloak no Compose, com o realm importado (clients dos provedores e do operador);
- teste e2e com o token real;
- `README.md`: setup, comandos, como pegar o token, os `curl` do §9 e o `send-message` do §10;
- `ARCHITECTURE.md` com tudo o que a D11.5 lista, mais as interpretações (D1.6) e as limitações;
- `scripts/acceptance.sh` completo.

**Contratos da S3:** o `AUTH_ISSUER` do Compose (hoje `http://keycloak:8080/realms/wagering`) precisa bater com o emissor (`iss`) que vem no token do Keycloak, que depende do host usado para pedir o token; senão toda requisição dá `401` (D10.1, D16.1). O `prom-client` aparece como deprecated no install (substituído por `@prometheus-io/client`): avaliar na S9, junto com o `/metrics` (D11.2, D16.6).

**Cobre:** R-02-03, R-14-02, R-04-10, R-08-07 · D10, D11.5

**Aceite:**
- de um clone limpo, `bun run infra:up && bun run acceptance` passa;
- o `ARCHITECTURE.md` cobre cada item da seção "O que precisa ser documentado" do `01-requisitos.md`;
- tag `v1.0-core`.

---

## Depois do núcleo: extras

Na ordem de `02-decisoes.md`, seção "Encaixes":
1. WebSocket;
2. partidas dobradas;
3. Terraform;
4. Secrets Manager;
5. S3;
6. observabilidade completa;
7. k6;
8. frontend;
9. Kubernetes;
10. CI.

Cada um:
1. decisão curta aprovada;
2. testes primeiro;
3. `bun run check` e `bun run acceptance` continuam verdes;
4. revisão num contexto limpo.
