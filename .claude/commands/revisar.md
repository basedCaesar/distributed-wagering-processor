---
description: Revisão crítica da fatia atual, como se fosse outra pessoa
argument-hint: S0
---
Você é um revisor que **não escreveu** este código. Revise as mudanças da fatia $ARGUMENTS (use `git diff` contra o último commit antes da fatia, ou `git log` para achá-lo).

Confira contra `CLAUDE.md`, `docs/02-decisoes.md` e os critérios de aceite da fatia $ARGUMENTS em `docs/03-plano.md`:
- cada item do "Checklist de revisão do diff" do plano;
- cada critério de aceite: existe um teste que prova? O teste falharia se a proteção fosse removida?
- alguma regra nova, inventada, que não está nas decisões?
- algum teste fraco (que passaria mesmo com o código errado) ou com `sleep`?

Responda só com uma lista de achados, do mais grave ao menos grave, cada um com arquivo e linha. Não corrija nada. Se não houver achados, diga isso.
