# Testes

| Suíte | Comando | O que usa |
|---|---|---|
| `unit/` | `bun run test:unit` | nada externo (domínio, políticas, config, `classifyError`, remoção segura das provas) |
| `integration/` | `bun run test:integration` | Postgres e LocalStack **reais** (`bun run infra:test:up`), com o papel da app; alguns também o Docker direto |
| `concurrency/` | `bun run test:concurrency` | o mesmo, com paralelismo real e processos Bun separados |
| `e2e/` | `bun run test:e2e` | o Keycloak **real** do Compose de teste (porta 8081, `E2E_KEYCLOAK_URL`): tokens por `client_credentials` contra a api no processo (D10.3, D23.5). O `beforeAll` espera o JWKS e o endpoint de token de cada client responderem (polling, teto de 120 s, só o "ainda não pronto" se repete), porque o primeiro token de um Keycloak frio pode passar dos 5 s de um teste. O `Bun.sleep` do `beforeAll` é só o intervalo de 500 ms entre duas tentativas desse polling, não uma espera cega. O e2e depende do `--wait` do `infra:test:up`: com ele, o Keycloak só conta como pronto depois do healthcheck, com o realm `wagering` importado. Sem ele, o JWKS de um realm ainda em importação responde `404`, e o polling aborta na hora, porque só repete falta de conexão, prazo estourado e `5xx` |
| provas | `bun run test:proofs` | cópia do repositório e banco descartável (`proofs/README.md`, D21.8) |
| aceitação | `bun run acceptance` | o Compose de dev inteiro (`bun run infra:up`): os exemplos do §9 e do §10, literais (D23.2, D23.6) |

`bun run check` roda typecheck, lint, `proofs:check` (cada patch de `proofs/` ainda aplica na árvore atual, sem rodar as provas), unidade, `migration:verify`, integração, concorrência e e2e. A concorrência precisa ficar verde em 10 rodadas seguidas: `bun run test:repeat concurrency 10` (log de cada falha em `logs/test-repeat/`).

A **aceitação fica fora do `check`**: precisa do Compose de dev completo (3 api, consumidores, Keycloak, seed), que o `check` não sobe. Ela roda no CI, num job próprio, duas vezes (D23.7, D25.1).

### Validação do clone limpo

Validação final:
- **Data:** 02/11/2026, 20:48 (-03:00).
- **Commit:** `1d6c736` (`build: --build no infra:up [S10 D23.8]`), clonado sem nenhuma mudança local.
- **Antes:** Compose do projeto derrubado e imagem `wagering-app:local` apagada.
- **Passos, e só eles:** `git clone` numa pasta nova; `bun install`; `bun run infra:up` (construiu a imagem do código do clone); `bun run acceptance` duas vezes seguidas.
- **Resultado:**
  - seed: "wallet do exemplo criada";
  - 1ª aceitação: saída 0, tudo ok, com `idempotentReplay: false` e "o consumidor processou msg-123 (linha da inbox gravada)";
  - 2ª aceitação: saída 0, tudo ok, com `idempotentReplay: true` e "a inbox já tinha msg-123 antes do envio… não prova um novo processamento".
- **Depois:** `docker compose down -v` no clone. A pasta foi apagada depois de conferir que não tinha link nem junction.

Antes dela, uma validação sobre `21377a1` com as mudanças da correção aplicadas, às 20:26 (aceitação duas vezes e o `seed` rodado de novo: "nada a fazer", saída 0). Na 1ª tentativa dessa validação, o `infra:up` ainda era `docker compose up -d`, sem `--build`. Ele reaproveitou uma `wagering-app:local` antiga da máquina, e o seed antigo falhou ao rodar de novo. Por isso o `infra:up` passou a usar `--build` (D23.8).

## CI (D25)

O `ci.yml` roda a cada push e pull request, em Linux (detalhes e como ver os resultados no [README](../README.md#ci)):
- **job `check`:** `bun run infra:test:up` e `bun run check` inteiro. A saída vai para `logs/ci/check.log`, e o step seguinte falha se algum resumo do bun tiver `skip` ou `todo`, e se não houver exatamente 5 linhas `(pass) … recebe SIGTERM` (D25.3);
- **job `acceptance`:** `bun run infra:up` e `bun run acceptance` duas vezes;
- **em falha:** `logs/` sobe como artefato, junto com os logs dos containers (D25.4).

O `test:proofs` roda à parte (`proofs.yml`), manual ou toda segunda (D25.5).

**Teste que só passa numa plataforma** é bug, não exceção do CI: nada de `skipIf(linux)` nem prazo maior para ficar verde (D25.7). O 1º caso foi o `removeLink` do `scripts/proofs.ts`. Fora do Windows, o junction do `node_modules` é um symlink comum, e o `rmdir` falhava com `ENOTDIR`.

## Regras (CLAUDE.md, D11.4)

- O nome do teste cita o requisito e/ou a decisão (`R-…`, `D…`).
- Banco e fila reais, nunca mockados, sempre com o papel da app. O banco de teste não é limpo entre arquivos (o ledger não aceita `DELETE`): cada teste usa ids próprios e estaciona o que deixa para trás (pendentes, outbox).
- Sincronização por estado observável (`pg_locks`, linhas do banco, a fila), nunca por `sleep`.
- Todo teste que move dinheiro termina com `expectLedgerMatchesBalances()`.

## Processos separados (D7.4, D21)

`support/processes.ts` sobe os entrypoints de produção (`src/entrypoints/main-*.ts`) em processos Bun separados contra a infra de teste, cada um com o seu `DB_APPLICATION_NAME` (D21.1), e grava o log de cada processo em `logs/processes/`. `kill()` mata **à força**. Usado por:

- `concurrency/multi-instance.spec.ts`: R-13-C4 (3 `api` + 3 `consumer`; o lock só é solto com as 3 `api` e pelo menos 1 `consumer` esperando a wallet no `pg_locks`);
- `concurrency/outbox-processes.spec.ts`: R-13-C6 com dois publishers separados (o entrypoint de teste `support/processes/outbox-publisher-child.ts` sobe o módulo de produção e troca só o provider `SNS_SENDER` por um decorador que conta cada `Publish`; nunca importe esse arquivo de um teste, porque o import roda o bootstrap dele);
- `concurrency/restart.spec.ts`: R-13-C8, a topologia inteira com reinícios no meio da carga. Cada processo só morre depois de o banco mostrar trabalho dele em andamento: `api` e `consumer` esperando a wallet travada (`pg_locks`), o worker com a pendente reivindicada (`locked_by` = o `leaseToken` que ele loga na subida) e o publisher com um evento reivindicado e o `Publish` parado em `support/holding-proxy.ts` (um proxy TCP na frente do LocalStack real, que o teste segura e solta);
- `integration/failures/postgres-restart.spec.ts`: F1 e F3, com um Postgres só do teste (`support/own-postgres.ts`, `docker run`, apagado num `finally`, D21.7).

## Plataforma: o `SIGTERM` real só roda fora do Windows (no CI, sempre)

No Windows, `kill("SIGTERM")` termina o processo à força, sem shutdown (D21.2). Por isso:

- o shutdown gracioso é provado em processo pelo `app.close()`, o mesmo caminho que o sinal dispara: `integration/shutdown/shutdown.spec.ts` e os testes de montagem do Nest;
- `integration/shutdown/sigterm.spec.ts` manda o `SIGTERM` real a cada entrypoint e **só roda fora do Windows** (`skipIf(win32)`); no Windows ele aparece como pulado (os 5 `skip` do `check` local). **No CI (Linux) ele roda a cada push**, e o job `check` falha se ele for pulado ou se não passarem os 5 (D25.3);
- antes do CI, a prova do `SIGTERM` real foi a conferência à mão de 01/11/2026 no Compose de dev, com `docker stop` (SIGTERM real, Linux) nos 11 processos da D7.4: todos saíram com código 0, com o log "conexões do banco fechadas", em até 20 s (D21.2).
