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
