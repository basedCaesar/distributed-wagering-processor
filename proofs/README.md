# Provas

Um teste verde só prova algo se ele **falha** quando a proteção que ele cobre some. Cada patch desta pasta remove uma proteção, e `bun run test:proofs` exige que o teste nomeado para ela falhe (D11.4, D21.8). Resultado da última rodada: tabela "Provas de que os testes protegem" do [`AI_WORKFLOW.md`](../AI_WORKFLOW.md).

```bash
bun run infra:test:up
bun run test:proofs          # as 17
bun run test:proofs 3 10     # só algumas, pelo número
bun run proofs:check         # só confere que cada patch aplica (git apply --check); roda dentro do check
```

## Como roda (D21.8)

Para cada prova de [`manifest.ts`](manifest.ts):

1. copia o repositório (o que o `git ls-files` conhece, inclusive arquivos novos ainda não commitados) para uma pasta temporária, com um junction para o `node_modules`;
2. cria o banco descartável `wagering_proof` no `postgres_test`, com o superusuário do Compose de teste e os mesmos dono e `GRANT`s do `postgres-init.sh`;
3. roda o teste nomeado **sem** o patch: tem que passar (senão a prova não diz nada);
4. aplica o patch (`git apply`) e roda de novo: tem que **falhar**;
5. num `finally`, mesmo se a prova quebrar: desfaz o junction primeiro, sem segui-lo (`removeLink`: `rmdir` no Windows, `unlink` fora dele, onde o junction é um symlink comum, D25.7), apaga o banco e apaga a cópia **sem** remoção recursiva. A cópia só é apagada se o caminho for uma `copy-*` dentro de `<tmp>/wagering-proofs/` e não houver nenhum link lá dentro; senão o script aborta sem apagar nada. No fim, ele confere que o `node_modules` do repositório não mudou. Nunca `git worktree remove` nem `rm -r`: foi assim que o `node_modules` foi apagado uma vez (registrado no `AI_WORKFLOW.md`). Testado em `test/unit/proofs-cleanup.spec.ts`, com junctions de verdade.

Nada disso toca a árvore de trabalho nem o banco `wagering_test`. Uma proteção do banco é removida por uma **migration nova** (`Migration20991231000001_proof`) que só existe na cópia: migration aplicada nunca é editada. O teste roda com `DB_NAME=wagering_proof` no ambiente, que vence o `--env-file` do Bun; o preload dos testes aplica as migrations, inclusive a da prova. Logs de cada execução em `logs/proofs/<início>/NN-base.log` e `NN-patched.log`.

## As 17

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
| 15 | `15-journal-balanced.patch` | triggers diferidos de débito = crédito do diário (D27.3) | §6.4 D27.3: débitos ≠ créditos → o COMMIT falha |
| 16 | `16-journal-append-only.patch` | trigger append-only das linhas do diário (D27.3) | D27.3: nem o dono faz UPDATE ou DELETE em `accounting.journal_lines` |
| 17 | `17-player-account-lock.patch` | `FOR UPDATE` da conta da wallet no accounting (D27.4) | D27.4: as duas metades do mesmo par processadas ao mesmo tempo em duas instâncias → exatamente um lançamento |

**Prova 17: falha pela asserção, não pela sincronização.** O teste prende o `INSERT` das duas metades (uma transação aberta grava linhas com os mesmos `event_id`), um ponto que existe com e sem o lock. Com o `FOR UPDATE`, uma instância fica presa ao gravar a metade e a outra espera a conta; sem ele, as duas leem "sem a outra metade" e ficam presas ao gravar. Nos dois casos o `pg_locks` mostra as duas esperando. Solto o `INSERT`, com o lock sai exatamente um lançamento; sem ele, as duas metades ficam gravadas e nenhum lançamento sai, e o teste falha na asserção do lançamento (revisão da S14).

**Patches 02, 03, 04 e 12 na S14:** só o contexto do `migrations/index.ts` mudou (a migration do accounting é a vizinha anterior); a proteção removida é a mesma, e as quatro foram rodadas de novo (passa sem, falha com).

**Provas 3 e 4: defesa em camadas.** Sem o `CHECK` de saldo ≥ 0, um saldo negativo ainda é recusado, por outro trigger (`23000`). Sem o trigger append-only, o `UPDATE` no ledger ainda é recusado, por um `CHECK` (`23514`). Nas duas, o teste falha **pelo código do erro**: ele é específico da proteção removida e exige que a recusa venha dela (`CHECK` e trigger append-only, respectivamente). A prova mostra que o teste pega a remoção, não que a proteção é a única barreira: há outra proteção que também recusa, de propósito (D7.3, invariantes no banco).

O título exato de cada teste está no manifesto. Um patch que deixar de aplicar (o código mudou) faz a prova falhar com a saída do `git apply`: atualize o patch, nunca o teste.
