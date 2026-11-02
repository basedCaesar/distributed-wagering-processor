# Testes

| Suíte | Comando | O que usa |
|---|---|---|
| `unit/` | `bun run test:unit` | nada externo (domínio, políticas, config, `classifyError`, remoção segura das provas) |
| `integration/` | `bun run test:integration` | Postgres e LocalStack **reais** (`bun run infra:test:up`), com o papel da app; alguns também o Docker direto |
| `concurrency/` | `bun run test:concurrency` | o mesmo, com paralelismo real e processos Bun separados |
| `e2e/` | `bun run test:e2e` | o Keycloak **real** do Compose de teste (porta 8081, `E2E_KEYCLOAK_URL`): tokens por `client_credentials` contra a api no processo (D10.3, D23.5) |
| provas | `bun run test:proofs` | cópia do repositório e banco descartável (`proofs/README.md`, D21.8) |
| aceitação | `bun run acceptance` | o Compose de dev inteiro (`bun run infra:up`): os exemplos do §9 e do §10, literais (D23.2, D23.6) |

`bun run check` roda typecheck, lint, unidade, `migration:verify`, integração, concorrência e e2e. A concorrência precisa ficar verde em 10 rodadas seguidas: `bun run test:repeat concurrency 10` (log de cada falha em `logs/test-repeat/`).

## Regras (CLAUDE.md, D11.4)

- O nome do teste cita o requisito e/ou a decisão (`R-…`, `D…`).
- Banco e fila reais, nunca mockados, sempre com o papel da app. O banco de teste não é limpo entre arquivos (o ledger não aceita `DELETE`): cada teste usa ids próprios e estaciona o que deixa para trás (pendentes, outbox).
- Sincronização por estado observável (`pg_locks`, linhas do banco, a fila), nunca por `sleep`.
- Todo teste que move dinheiro termina com `expectLedgerMatchesBalances()`.

## Processos separados (S8, D7.4, D21)

`support/processes.ts` sobe os entrypoints de produção (`src/entrypoints/main-*.ts`) em processos Bun separados contra a infra de teste, cada um com o seu `DB_APPLICATION_NAME` (D21.1), e grava o log de cada processo em `logs/processes/`. `kill()` mata **à força**. Usado por:

- `concurrency/multi-instance.spec.ts`: R-13-C4 (3 `api` + 3 `consumer`; o lock só é solto com as 3 `api` e pelo menos 1 `consumer` esperando a wallet no `pg_locks`);
- `concurrency/outbox-processes.spec.ts`: R-13-C6 com dois publishers separados (o entrypoint de teste `support/processes/outbox-publisher-child.ts` sobe o módulo de produção e troca só o provider `SNS_SENDER` por um decorador que conta cada `Publish`; nunca importe esse arquivo de um teste, porque o import roda o bootstrap dele);
- `concurrency/restart.spec.ts`: R-13-C8, a topologia inteira com reinícios no meio da carga. Cada processo só morre depois de o banco mostrar trabalho dele em andamento: `api` e `consumer` esperando a wallet travada (`pg_locks`), o worker com a pendente reivindicada (`locked_by` = o `leaseToken` que ele loga na subida) e o publisher com um evento reivindicado e o `Publish` parado em `support/holding-proxy.ts` (um proxy TCP na frente do LocalStack real, que o teste segura e solta);
- `integration/failures/postgres-restart.spec.ts`: F1 e F3, com um Postgres só do teste (`support/own-postgres.ts`, `docker run`, apagado num `finally`, D21.7).

## Plataforma: o `SIGTERM` real só roda fora do Windows (ainda sem CI)

No Windows, `kill("SIGTERM")` termina o processo à força, sem shutdown (D21.2). Por isso:

- o shutdown gracioso é provado em processo pelo `app.close()`, o mesmo caminho que o sinal dispara: `integration/shutdown/shutdown.spec.ts` e os testes de montagem do Nest;
- `integration/shutdown/sigterm.spec.ts` manda o `SIGTERM` real a cada entrypoint e **só roda fora do Windows** (`skipIf(win32)`); no Windows ele aparece como pulado (os 5 `skip` do `check`). **Hoje não há CI**: o CI é o primeiro extra, depois da S10, e é lá que esse teste vai rodar sempre. Até lá, ele só roda se alguém executar a suíte num Linux;
- até o CI existir, a prova do `SIGTERM` real é a conferência à mão de 01/11/2026 no Compose de dev, com `docker stop` (SIGTERM real, Linux) nos 11 processos da D7.4: todos saíram com código 0, com o log "conexões do banco fechadas", em até 20 s (D21.2).
