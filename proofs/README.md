# Provas

Um teste verde só prova algo se ele **falha** quando a proteção que ele cobre some. Cada patch desta pasta remove uma proteção, e `bun run test:proofs` exige que o teste nomeado para ela falhe (D11.4, D21.8). Resultado da última rodada: tabela "Provas de que os testes protegem" do [`AI_WORKFLOW.md`](../AI_WORKFLOW.md).

```bash
bun run infra:test:up
bun run test:proofs          # as 14
bun run test:proofs 3 10     # só algumas, pelo número
```

## Como roda (D21.8)

Para cada prova de [`manifest.ts`](manifest.ts):

1. copia o repositório (o que o `git ls-files` conhece, inclusive arquivos novos ainda não commitados) para uma pasta temporária, com um junction para o `node_modules`;
2. cria o banco descartável `wagering_proof` no `postgres_test`, com o superusuário do Compose de teste e os mesmos dono e `GRANT`s do `postgres-init.sh`;
3. roda o teste nomeado **sem** o patch: tem que passar (senão a prova não diz nada);
4. aplica o patch (`git apply`) e roda de novo: tem que **falhar**;
5. num `finally`, mesmo se a prova quebrar: desfaz o junction primeiro (com `rmdir`, que remove só o link), apaga o banco e apaga a cópia **sem** remoção recursiva. A cópia só é apagada se o caminho for uma `copy-*` dentro de `<tmp>/wagering-proofs/` e não houver nenhum link lá dentro; senão o script aborta sem apagar nada. No fim, ele confere que o `node_modules` do repositório não mudou. Nunca `git worktree remove` nem `rm -r`: foi assim que o `node_modules` foi apagado uma vez (AI_WORKFLOW, S8). Testado em `test/unit/proofs-cleanup.spec.ts`, com junctions de verdade.

Nada disso toca a árvore de trabalho nem o banco `wagering_test`. Uma proteção do banco é removida por uma **migration nova** (`Migration20991231000001_proof`) que só existe na cópia: migration aplicada nunca é editada. O teste roda com `DB_NAME=wagering_proof` no ambiente, que vence o `--env-file` do Bun; o preload dos testes aplica as migrations, inclusive a da prova. Logs de cada execução em `logs/proofs/<início>/NN-base.log` e `NN-patched.log`.

## As 14

| # | Patch | Proteção removida | Teste que falha |
|---|---|---|---|
| 1 | `01-for-update.patch` | `FOR UPDATE` da wallet (D7.2) | R-13-C2 (duas BETs de 80.00 no mesmo lock) |
| 2 | `02-reversal-index.patch` | índice de uma reversão `PROCESSED` por referência (D1.1) | R-07-09 D1.1 (schema) |
| 3 | `03-balance-check.patch` | `CHECK` de saldo ≥ 0 (D7.3) | R-05-09 R-06-25 (schema) |
| 4 | `04-ledger-append-only.patch` | trigger append-only do ledger (D7.3) | R-05-05 (P2, papel dono) |
| 5 | `05-pending-skip-locked.patch` | `SKIP LOCKED` no claim do worker (D4.3) | D4.3 D18.2 |
| 6 | `06-outbox-skip-locked.patch` | `SKIP LOCKED` no claim da outbox (D20.3) | 2º teste do R-13-C6 (D20.3) |
| 7 | `07-nudge.patch` | cutucada das pendentes (D4.4) | D4.4 |
| 8 | `08-tiebreak-inverted.patch` | desempate da D18.9, invertido | D1.1 D1.3 D18.9 |
| 9 | `09-lease-owner.patch` | dono do lease do worker (D18.10) | D18.10 D4.3 |
| 10 | `10-ack-before-commit.patch` | ack só depois do commit (R-10-05) | R-13-I2 |
| 11 | `11-inbox.patch` | inbox (D3.7) | R-10-04 R-13-I3 |
| 12 | `12-ledger-tail.patch` | trigger de cauda (D7.3) | R-06-21 |
| 13 | `13-restricted-role.patch` | papel restrito do banco (D7.3) | D7.3: papel que não é superusuário nem dono |
| 14 | `14-mark-published-owner.patch` | `AND locked_by = ?` no `markPublished` (D20.5) | D20.5: A publica depois de B pegar o lease |

O título exato de cada teste está no manifesto. Um patch que deixar de aplicar (o código mudou) faz a prova falhar com a saída do `git apply`: atualize o patch, nunca o teste.
