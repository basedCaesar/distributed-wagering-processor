# Como este projeto foi desenvolvido com IA

Este projeto foi construído com um agente de IA como par de programação. Os requisitos e as decisões vieram antes do código, a IA implementou dentro dessas regras, e cada entrega foi verificada por testes automáticos e revisão humana.

## Processo

1. **Requisitos literais** (`docs/01-requisitos.md`): cada exigência do enunciado copiada com ID e linha. Ambiguidades e silêncios ficaram listados à parte, sem resposta. Duas auditorias em contexto limpo encontraram omissões e interpretações, que foram corrigidas.
2. **Decisões** (`docs/02-decisoes.md`): cada ponto em aberto resolvido com o motivo e as alternativas descartadas, aprovado por mim.
3. **Plano em fatias** (`docs/03-plano.md`), com critérios de aceite.
4. **Implementação**, uma fatia por vez: plano do agente → minha revisão → testes primeiro → código → `bun run check` → revisão do diff com checklist → commit citando os IDs.

## O harness

| Peça | Papel |
|---|---|
| `CLAUDE.md` | Regras invioláveis que o agente lê antes de cada tarefa |
| IDs `R-…` e `D…` | Todo teste e todo commit citam o requisito e a decisão |
| Lint de pureza (Biome) | Impede o domínio de importar framework e de usar `number` para dinheiro |
| `bun run check` | Única porta de "pronto" |
| `bun run test:proofs` | Remove proteções de propósito e exige que os testes falhem |
| `bun run acceptance` | Roda os exemplos do enunciado exatamente como estão |

## Onde a IA errou e como foi pego

| Fase/Fatia | O que a IA fez | Como percebi | Correção |
|---|---|---|---|
| Requisitos | Misturou interpretação com citação ("payload inválido não persiste") | Auditoria em contexto limpo | Virou pergunta na Parte B |
| Decisões | Replay "com o mesmo status" contradizia "pendente resolvida devolve o resultado novo" | Revisão final das decisões | D3.4 reescrita |
| Decisões | A "cutucada" de pendentes de outras wallets podia formar ciclo de locks | Revisão final das decisões | Só pendentes da mesma wallet, com `SKIP LOCKED` (D4.4) |
| Decisões | `WIN` referenciando `BET` rejeitada pagaria ganho sem aposta | Revisão final das decisões | `REFERENCE_NOT_PROCESSED` para toda referência (D1.4) |
| S0 | Nomeou testes com IDs errados (`R-12-04` nas moedas, `D-stack` inexistente) | Revisão do plano antes de aprovar | IDs corrigidos para `D2.5`/`D12.3` |
| S0 | O plano criava as filas sem deduplicação, sem redrive e sem o tópico SNS | Revisão do plano contra a D8/D9 | O init cria tudo, e um teste confere os atributos |
| S0 | O health do SQS usava `GetQueueUrl` em vez do `GetQueueAttributes` decidido na D11.3 | `/revisar` em contexto limpo | Corrigido |
| D13 | O prompt da D13 contradizia a D11.5, não liberava o /docs nas regras e não punha o @nestjs/swagger na Stack | O agente apontou ao mostrar o diff, antes da aprovação | D11.5 ajustada, /docs aberto e @nestjs/swagger na Stack |
| S1 | Escreveu dois testes com expectativa errada: (1) o `ROLLBACK` de `WIN` esperava saldo final 70, mas o certo é 100 (saldo 100, ganha 15, devolve 15); (2) um teste montava um valor negativo com `brl("-15.00")`, que o `Money.from` já rejeita antes de chegar ao que se queria testar | O próprio agente, ao implementar | Mudança só nos testes, aprovada por mim: a expectativa virou 100 e o valor negativo passou a ser `brl("15.00").negate()`. A implementação não mudou |
| S2 | Montou mal quatro testes de schema, que falhavam por uma constraint **diferente** da que queriam provar: (1) o helper `nextEntry` fixava `balance_after = 90.00`, mas o saldo já tinha mudado, e caía no `CHECK` de aritmética antes da FK; (2) a "BET com referência" ficava `PROCESSED` sem o id interno e caía no `processed_ck`; (3) dois testes montavam um saldo de 14 dígitos com `Money.from`, que aceita só 12 na entrada | O próprio agente, ao rodar os testes contra as migrations | Só a montagem mudou (o helper calcula o saldo; a BET vira `REJECTED` para isolar a regra de kind; o saldo usa `Money.rehydrate`). As expectativas (código e constraint) não mudaram. Aprovada por mim |
| S2 | O trigger de cauda usava `CASE` com `NEW.wallet_id` num gatilho de `wallets`, e o plpgsql resolve os campos dos dois ramos | Os testes de schema quebraram com `record "new" has no field` | `IF` no lugar do `CASE`, na própria migration (ainda não commitada nem aplicada fora do banco de teste) |
| S2 | Deixou buracos de garantia e de teste: (1) o `correlation_id` estava na lista de colunas imutáveis, mas fora do mapeamento do ORM, então nunca seria gravado (D9.5); (2) faltavam testes da D15.6 (`OPENING` fora do início, primeiro lançamento com saldo anterior) e de metade das transições da D15.5; (3) o `migration:verify` comparava só nomes; (4) o banco aceitava lançamento de transação `REJECTED` e `BET` `PROCESSED` sem lançamento, e os próprios testes gravavam isso; (5) o `INSERT` aceitava `FAILED`; (6) `ledger.spec.ts` dependia da ordem dos testes; (7) o `expectDbError` aceitava qualquer constraint quando ela não era informada; (8) três testes citavam `R-06-24` para a wallet única, que é a `R-06-22` | `/revisar` em contexto limpo | `correlation_id` mapeado e testado; D15.9 e o ajuste da D15.5 aprovados, numa migration nova (`…000007`), sem editar as aplicadas; testes nos dois sentidos; `migration:verify` compara as definições completas; testes com movimento completo e wallet própria; constraint obrigatória fora do `42501`; IDs corrigidos. Um teste mudou por causa da regra nova, não para passar: "`FAILED` com código de rejeição" agora chega ao `CHECK` por `UPDATE`, porque o `INSERT` de `FAILED` é recusado antes |
| S2 | O healthcheck do Postgres (`pg_isready` sem host) passava durante o init, quando o servidor temporário só escuta no socket Unix, e o serviço `migrate` falhava com `ECONNREFUSED` | Subindo o Compose de dev completo, a pedido meu | Healthcheck por TCP (`pg_isready -h 127.0.0.1`) nos dois Compose |
| S2 | Uma falha em 29 rodadas de integração, sem o log guardado | Rodada de 10× | Não reproduzida em 28 rodadas; a partir daqui as rodadas de 10× salvam o log de cada falha |
| | | | |

## Provas de que os testes protegem

Resultado de `bun run test:proofs`, preenchido na S8:

| Proteção removida | Teste que precisa falhar | Resultado |
|---|---|---|
| `FOR UPDATE` da wallet | R-13-C2 | |
| Índice de uma reversão por referência | dupla reversão em paralelo | |
| `CHECK` de saldo ≥ 0 | `UPDATE` direto com saldo negativo | |
| Trigger append-only do ledger | `UPDATE` com o papel dono | |
| Trigger de cauda (saldo = último lançamento) | saldo alterado sem lançamento | |
| `SKIP LOCKED` da outbox | R-13-C6 | |
| Ack depois do commit | R-13-C5 | |
| Inbox | mesma mensagem duas vezes | |
| Papel restrito do banco | `UPDATE` no ledger com o papel da app | |

## O que eu fiz sem a IA

Preencher: decisões, leituras e depuração que fizeram diferença.
