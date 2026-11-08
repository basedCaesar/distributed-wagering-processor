# Teste de carga

Diferencial do §14 (R-14-O1): `bun run test:load`, decidido na D26. Este documento traz os números reais de uma execução de 3 rodadas na máquina de desenvolvimento, em 08/11/2026, e a análise deles. O relatório gerado dessa execução está em `logs/load/20261108T171033/report.md`, fora do git. Como o teste funciona: [`load/README.md`](../load/README.md).

**Não há meta de RPS** (§14). O teste reprova só pela correção depois da carga ou por status inesperado, nunca por latência (D26.6).

## Resumo

- **Correção: passou nas 3 rodadas.** Em cada uma:
  - as 314 wallets da rodada reconciliadas com `consistent: true`;
  - nenhum saldo negativo;
  - saldo = soma das transações `PROCESSED`;
  - nenhuma transação `PROCESSED` sem lançamento no ledger, nenhum lançamento órfão;
  - cada operação confirmada (`200`/`422`) está no banco;
  - duplicatas: exatamente 1 transação e **exatamente 1 resposta original por key**, nas 50 keys, com 899 a 934 duplicatas pegas no lock (as cópias disputaram de verdade);
  - fila: 2 000 mensagens, 2 000 linhas na inbox, 2 000 transações, nada na DLQ, nenhum status inesperado no envio;
  - outbox vazia no fim da rodada;
  - **zero status inesperados**, inclusive no aquecimento.
- **Muitas wallets:** escala linearmente até 200 req/s, com p99 de 199 a 778 ms. Satura em **268 a 285 resoluções/s**. A 400 req/s, o p50 passa de 2 s e o k6 deixa de iniciar ~3 500 a 4 000 chegadas por falta de VU. A espera do lock continua na casa dos milissegundos: o gargalo não é o lock da wallet.
- **Hot wallet:** **~8 a 13 transações/s**, qualquer que seja a taxa pedida. O lock pessimista serializa a wallet por desenho (D7.2), e cada transação segura o lock até o commit, que espera o fsync do WAL. Neste disco (o do Docker Desktop no WSL2), cada fsync leva perto de 50 ms.
- **Outbox:** sob carga, o publisher fica para trás e alcança depois, sem perder nem reordenar nada:
  - muitas wallets: lag máximo de 39 a 101 s a 200 req/s, e de 62 a 125 s a 400 req/s;
  - hot wallet: 81 a 194 s, porque uma wallet publica um evento por ciclo (D9.2, D20.3).
- **Achados corrigidos durante a fatia:** o teto de 512 conexões do nginx (D26.10). **Achados documentados, sem mudança:**
  - o fsync limitando a hot wallet (`synchronous_commit` mantido);
  - a vazão por wallet da outbox;
  - o auditor de instância única, a ~11 a 15 eventos/s.

## Ambiente

| Item | Valor |
|---|---|
| SO do host | Windows 11 Pro (10.0.26200) |
| CPU do host | AMD Ryzen 7 3700X, 8 núcleos, 16 threads lógicas |
| RAM do host | 31,9 GB |
| VM do Docker | Docker Desktop (WSL2), 16 CPUs, 15,6 GB, kernel 5.15.167.4-microsoft-standard-WSL2 |
| Docker | Engine 28.0.1, Compose 2.33.1-desktop.1 |
| Bun | 1.4.4 (orquestrador e imagem da app) |
| k6 | v2.3.0 (`grafana/k6:2.3.0`), num container na rede do Compose |
| PostgreSQL | 16.15, `max_connections` 100, `synchronous_commit = on`, `fsync = on`, `wal_sync_method = fdatasync`; dados num ext4 no disco virtual do WSL2 |
| LocalStack | 3 (SQS FIFO, SNS FIFO) |
| Topologia | nginx → 3 `api`; 3 `consumer`; 2 `outbox-publisher`; 2 `pending-worker`; 1 `event-auditor` (D7.4), todos na mesma VM, junto com o k6, o Postgres, o LocalStack e o Keycloak |
| Commit medido | `c8c082292e026b61c4de7d8e38bfbf6d78fa02a4` ("fix: achados da revisão da S13") |
| Árvore de trabalho | limpa (`git status --porcelain` vazio), registrada pelo próprio relatório |
| Execução | `20261108T171033`, de 17:10:33 a 18:40:08 UTC (1h30), 3 rodadas, todos os cenários |
| Estado inicial | Compose de dev derrubado e subido de novo (`bun run infra:down` + `bun run infra:up`), **sem apagar os volumes**: o banco e as filas traziam os dados das execuções anteriores (ver abaixo) |

**Estado inicial.** O banco não foi recriado do zero nesta execução: o `down -v` foi negado pela política de permissões da sessão do agente, por apagar dados locais. A correção não depende disso: wallets e ids externos levam o prefixo `load-<execução>-r<rodada>`, e as checagens olham só para eles (D26.2). O efeito visível é nas medições: a fila do `event-auditor` começou com 427 eventos de uma execução anterior, e o banco já tinha as tabelas maiores.

## Metodologia

Resumo da D26. Detalhes em `docs/02-decisoes.md`, D26.1 a D26.13.

- **Cliente:** k6 num container na rede do Compose, chamando o `nginx:80` e lendo o `/metrics` interno de cada processo (D22.1) sem porta exposta.
- **Modelo aberto** (`constant-arrival-rate`): as chegadas não esperam a resposta anterior, então a lentidão do servidor não esconde a própria latência. Chegada que o k6 não consegue iniciar por falta de VU (teto de 600) aparece como **descartada**; essas requisições nunca foram enviadas.
- **Cenários:**

  | Cenário | O que roda |
  |---|---|
  | Aquecimento | 25 req/s por 15 s; os números são descartados, mas a correção e o status inesperado contam (D26.6) |
  | A | 200 wallets, 70% BET e 30% WIN sem referência, chaves únicas; degraus de 50, 100, 200 e 400 req/s, **30 s cada** |
  | B | uma wallet nova por degrau, com saldo para 70% das BETs previstas; degraus de 10, 25, 50 e 100 req/s, 30 s cada |
  | C | 50 keys × 20 cópias **simultâneas**, em 10 wallets: as 20 cópias da key k esperam o mesmo instante absoluto, `início + k × 3 s`, calculado no setup do k6 (D26.2) |
  | D | 2 000 mensagens do §10 em 100 wallets (`MessageGroupId` = walletId), por `SendMessageBatch` direto no LocalStack (atalho só dele, D26.9) |

- **`503`:** o cliente reenvia com a mesma key, respeitando o `Retry-After`, até 5 tentativas (D26.5).
  - **Taxa de erro** = (desistências + inesperados) / operações.
  - **Latência por tentativa:** cada requisição.
  - **Latência por operação:** inclui as esperas dos reenvios.
- **Duplicatas (C):** as respostas com `idempotentReplay: false` são contadas **key a key** (tag da key no `--out json` do k6); cada key precisa de exatamente 1. A diferença do `wagering_duplicates_total` por camada (D17.7) mostra onde cada cópia foi barrada; se nenhuma for pega no lock, o C reprova, porque as cópias não disputaram de verdade.
- **Métricas do servidor:** diferença do `/metrics` antes e depois de cada passo, somada entre as instâncias. A espera do lock (`wallet_lock_wait_seconds`) e a latência de processamento (`wagering_processing_duration_seconds`, em volta do use case) são **percentis estimados pelos buckets**, com erro do tamanho do bucket. Os do k6 usam todas as amostras.
- **Outbox lag:** o `outbox_lag_seconds` dos 2 publishers, lido a cada 1 s durante o passo e depois dele, até a outbox esvaziar (teto de 180 s). **Essa espera é medição e não reprova** (D26.6): a hot wallet gera eventos mais rápido do que a ordem por wallet deixa publicar (D9.2, D20.3), o que é desempenho, não perda. O critério de correção é a outbox vazia no fim da rodada, dentro do teto.
- **Repouso antes de cada passo** (D26.11): outbox vazia, nenhuma sessão da app ativa no banco e os `_count` parados entre duas leituras. Nas 3 rodadas, quase todo passo entrou em repouso na 2ª leitura (16,6 a 24,0 s, só o custo de medir). A exceção foi o C da rodada 2 (73,2 s): a outbox da hot wallet do B 100/s ainda estava esvaziando.
  - O `event-auditor` fica fora da condição (D26.13): a fila dele antes de cada passo é registrada como **contaminação conhecida**. A vazão dele só é medida a partir da 1ª leitura com a outbox vazia, quando não entram mais eventos na fila dele.
- **Tokens:** um por passo, pedido fora da medição (D26.3). Foram 36 pedidos na execução inteira, nenhum durante uma janela medida, então o Keycloak não pesou nos números.

### Operações interrompidas (`status=0`, erro 1050)

No fim do B 100/s, o log do k6 traz respostas com `status=0 … error=1050` (51, 44 e 24 linhas nas 3 rodadas; o log guarda no máximo 5 por VU). A classificação:

- **Origem:** todas as linhas de cada rodada caem num mesmo segundo, o do fim do `gracefulStop` do passo (30 s de carga + 30 s de prazo). O 1050 é o código do k6 para requisição cortada por tempo: são as requisições ainda esperando o lock da hot wallet quando o k6 encerrou as iterações em andamento.
- **O que o k6 faz:** descarta as métricas que essas iterações emitiriam depois. Elas ficam sem desfecho no resumo: operações iniciadas menos (resolvidas + desistências + inesperados).
- **Como aparecem:** na coluna **Interrompidas (k6)** (156, 158 e 84 no B 100/s), **fora** dos erros e dos status inesperados, porque o servidor não respondeu nada errado: o cliente desistiu de esperar.
- **Correção:** o efeito delas no banco é coberto pelas checagens. No B 100/s, as transações gravadas no banco foram exatamente as operações enviadas (533, 559 e 518): as interrompidas commitaram depois do corte, e o saldo, o ledger e a reconciliação conferem.

## Resultados

Os números das 3 rodadas aparecem lado a lado (r1 / r2 / r3). Latência HTTP por tentativa, do k6.

### A: muitas wallets em paralelo

| Degrau | Resolvidas/s | p50 | p95 | p99 | Descartadas (k6) | `503` | Inesperados |
|---|---|---|---|---|---|---|---|
| 50/s | 50,0 / 50,0 / 50,0 | 91 / 91 / 98 ms | 170 / 132 / 192 ms | 301 / 154 / 259 ms | 0 | 0 | 0 |
| 100/s | 100,0 / 100,0 / 100,0 | 87 / 93 / 87 ms | 156 / 155 / 147 ms | 366 / 208 / 187 ms | 0 | 0 | 0 |
| 200/s | 200,0 / 200,0 / 200,0 | 100 / 91 / 95 ms | 507 / 155 / 154 ms | 778 / 201 / 199 ms | 0 | 0 | 0 |
| 400/s | **276 / 285 / 268** | 2 221 / 2 178 / 2 277 ms | 2 586 / 2 648 / 2 611 ms | 2 736 / 2 781 / 2 690 ms | 3 729 / 3 463 / 3 961 | 0 | 0 |

**No servidor** (buckets):

| Degrau | Espera do lock p99 | Processamento p50 (http) | Processamento p95 |
|---|---|---|---|
| 50/s | 4,5 / 2,7 / 4,8 ms | 88 / 87 / 96 ms | 235 / 228 / 237 ms |
| 200/s | 6,4 / 4,5 / 5,0 ms | 99 / 88 / 92 ms | 519 / 229 / 232 ms |
| 400/s | 8,6 / 9,3 / 16,8 ms | 1 795 / 1 804 / 1 832 ms | 3 678 / 3 936 / 3 941 ms |

Nenhum conflito de lock no A.

**Outbox:**

| Degrau | Lag máximo | Pendentes no pico | Esvaziou em |
|---|---|---|---|
| 50/s | 1,4 / 1,1 / 3,4 s | 116 / 82 / 119 | 1,0 / 1,0 / 4,0 s |
| 100/s | 10,8 / 3,4 / 4,4 s | 1 583 / 434 / 807 | 11,1 / 2,0 / 4,0 s |
| 200/s | 38,9 / 72,8 / 100,7 s | 8 411 / 11 216 / 11 195 | 39,6 / 73,0 / 101,2 s |
| 400/s | 62,8 / 61,8 / 125,3 s | 13 384 / 13 478 / 15 338 | 63,4 / 61,8 / 126,0 s |

"Esvaziou em" conta a partir do fim da carga do degrau.

### B: uma hot wallet disputada

| Degrau | Resolvidas/s | p50 | p99 | `503` (tentativas) | Desistências | Interrompidas (k6) | Taxa de erro | Descartadas |
|---|---|---|---|---|---|---|---|---|
| 10/s | 9,4 / 9,7 / 9,7 | 627 / 507 / 524 ms | 5,0 s | 57 / 32 / 24 | 1 / 0 / 0 | 0 | 0,35% / 0% / 0% | 18 / 11 / 10 |
| 25/s | 11,5 / 10,4 / 11,7 | 5,9 a 6,8 s | 10,0 s | 129 / 200 / 128 | 0 | 0 | 0% | ~400 a 440 |
| 50/s | 12,2 / 13,1 / 12,1 | 10,0 s | 10,0 s | 460 / 629 / 479 | 0 | 0 | 0% | ~1 110 a 1 140 |
| 100/s | 7,7 / 7,9 / 9,8 | 10,0 s | 10,0 s | 1 590 / 1 686 / 1 628 | 145 / 164 / 139 | 156 / 158 / 84 | **27,2% / 29,3% / 26,8%** | ~2 450 |

- **Espera do lock** (buckets):
  - p50 de 311 a 389 ms a 10/s, e de 1,5 a 3,2 s acima disso;
  - p95 de 2,0 a 4,8 s;
  - conflitos `lock_timeout` de 0 a 36 por degrau.
- **Processamento:** p50 de 514 a 676 ms a 10/s; acima de 10 s nos degraus mais altos.
- **Replays:** de 77 a 277 por degrau a partir do B 25/s, com chaves únicas. São reenvios depois de um `503` de prazo da requisição (10 s, D21.3) cuja 1ª tentativa commitou depois, e o reenvio caiu no replay (D3.4).
- **Rejeições:** no B 10/s, exatamente 210 `PROCESSED` em cada rodada (o saldo cobria 70% das 300 BETs previstas) e 71 a 80 `REJECTED` com `INSUFFICIENT_FUNDS`, como planejado.
- **Outbox da hot wallet:** lag máximo de 81 a 194 s. No B 100/s da rodada 2, ela não esvaziou dentro dos 180 s depois do passo. Isso é medição, não reprovação (D26.6): ela esvaziou no repouso antes do C (73,2 s, o motivo aparece no relatório) e estava vazia na checagem de correção.

### C: duplicatas da mesma key

Em cada rodada:
- 1 000 envios: **50 respostas originais e 950 replays**, exatamente 1 original em cada uma das 50 keys, nenhum `409`;
- `503` (de `lock_timeout`) em 13 / 9 / 30 tentativas; o reenvio com a mesma key caiu no replay;
- no banco, 50 transações para 50 keys;
- p50 de 1,12 a 1,14 s e p99 de 2,28 a 2,31 s: as 20 cópias chegam juntas e esperam o lock da mesma wallet (D3.6);
- espera do lock com p95 de 2,7 a 3,4 s.

**Onde as duplicatas foram barradas** (`wagering_duplicates_total`, D17.7):

| | r1 | r2 | r3 |
|---|---|---|---|
| Fast path (antes do lock) | 22 | 16 | 51 |
| Lock (checagem autoritativa) | 928 | 934 | 899 |
| `unique_index` | 0 | 0 | 0 |

Com as cópias sincronizadas, quase todas chegam antes de a original commitar e são barradas na checagem depois do lock. Nenhuma passou por baixo dele até o índice único.

### D: mensagens pela fila

| | r1 | r2 | r3 |
|---|---|---|---|
| Fila vazia em | 76,5 s | 79,0 s | 80,4 s |
| Mensagens/s | 26,1 | 25,3 | 24,9 |
| Processamento no consumidor p50 / p99 | 90 / 248 ms | 94 / 344 ms | 92 / 395 ms |
| Inbox / transações / DLQ | 2 000 / 2 000 / 0 | 2 000 / 2 000 / 0 | 2 000 / 2 000 / 0 |

### Fila do auditor (contaminação conhecida, D26.13)

- A fila do `event-auditor` começou com 427 eventos de uma execução anterior (o banco não foi recriado) e chegou a ~91 mil mensagens antes do B da rodada 3; no fim, ~84 mil.
- Vazão medida nos repousos, só com a outbox vazia: **10,8 a 15,0 eventos/s**, todas as leituras positivas.
- Durante todos os passos, o auditor estava trabalhando e disputando o WAL do Postgres. Nos 11 processos, `audited_events_out_of_order_total`, `reconciliation_divergences_total` e `outbox_events_stalled_total` ficaram em 0 no fim da execução.

## Análise

### Muitas wallets: onde satura

- Até 200 req/s, a vazão acompanha a taxa pedida sem erro, com p50 estável em ~87 a 100 ms.
- A 400 req/s, satura em 268 a 285 resoluções/s. A latência no servidor sobe para ~1,8 s, e o k6 esgota os 600 VUs: cerca de um terço das chegadas não chega a ser enviado.
- A **espera do lock não muda** (p99 abaixo de 17 ms): não há disputa entre wallets, como esperado (sem lock global, D7).
- O tempo vai para dentro da api e do banco. Não isolei qual recurso satura primeiro. Os candidatos:
  - o commit (WAL compartilhado, com commit em grupo);
  - o pool de conexões de cada api;
  - a CPU da VM dividida entre o k6 e os 11 processos.
- **Limite do diagnóstico:** a foto das conexões do Postgres depois do A não pegou os pools das api (as conexões ociosas já tinham sido fechadas), então ela não mede o pico.
- O p50 de ~90 ms com carga baixa já é, quase todo, o commit esperando o fsync. Veja a hot wallet, abaixo.

### Hot wallet: limitada pelo fsync do commit

- Uma wallet processa **~8 a 13 transações/s**, qualquer que seja a taxa pedida.
- É o efeito esperado do lock pessimista (D7.2): as transações da mesma wallet são serializadas, e cada uma segura o lock até o commit.
- A investigação do B isolado (sem o A antes, feita durante a fatia) mostrou de onde vem o tempo com o lock segurado:
  - **`pg_stat_activity` amostrado a cada 0,2 s:** a sessão que segura o lock da hot wallet passa ~90% do tempo no `commit`, esperando `WALSync` (o fsync) ou `WALWrite` (a vez de quem faz o fsync). Foram 69 de 76 amostras da api fora da espera do lock.
  - **`pg_stat_wal`:** 190 fsyncs em 10,35 s, ~18/s, com o `WALSync` quase sempre ocupado. Isso dá perto de 50 ms por `fdatasync` neste disco (ext4 no disco virtual do WSL2, gravando no disco do Windows).
- Na hot wallet não há commit em grupo: a transação seguinte só começa depois de a anterior commitar. O teto fica em ~1 / (fsync + fila do WAL), uns 10/s.
- O auditor e o publisher também fazem commits com fsync e disputam o mesmo WAL, o que agrava.
- **O que isso causa:**
  - acima de ~10/s, as requisições esperam o lock até o `lock_timeout` de 2 s (`503`) ou o prazo da requisição de 10 s (`503`, D21.3);
  - o reenvio com a mesma key amplifica a fila: no B 100/s, 1 600 a 1 700 `503` e 27 a 29% de desistências depois de 5 tentativas;
  - **o dinheiro continua certo:** nenhum débito duplicado, e os replays mostram que o reenvio de uma requisição que commitou depois do prazo cai no replay.
- **`synchronous_commit` não foi mexido.** Desligá-lo tiraria o fsync do caminho do commit e multiplicaria a vazão da hot wallet, mas um commit confirmado ao provedor poderia se perder numa queda do Postgres. **Não trocamos durabilidade de dinheiro por vazão.**
- **Em produção:** num disco com fsync de ~1 ms, o mesmo desenho deveria subir esse teto em cerca de uma ordem de grandeza. É uma estimativa, **não medida aqui**.
- Subir o teto da hot wallet de verdade pede outro desenho de concorrência (saldo particionado, update atômico condicionado sem o lock da linha, D7), e isso seria uma decisão nova.

### Outbox: vazão por wallet

- A garantia de ordem por wallet (D9.2) faz o claim pegar só a **cabeça** de cada wallet (D20.3, `infra/outbox/README.md`). Uma wallet publica no máximo um evento por ciclo: 1 claim commitado, 1 `Publish` e 1 commit da marcação, cada commit com o seu fsync.
- **Hot wallet:** gera ~2 eventos por transação, a ~10 tx/s. A outbox dela cresce durante o passo e leva de 80 a mais de 180 s para esvaziar. Por isso a espera depois de cada passo é medição, e o critério é a outbox vazia no fim da rodada (D26.6).
- **Muitas wallets:** a 200 req/s são ~400 eventos/s. O lote de 50 cabeças por ciclo e os 2 publishers não acompanham, e o lag chega a 39 a 101 s, com ~8 a 11 mil pendentes.
- **Nenhum evento ficou para trás**: a outbox esvaziou antes de cada passo e de cada checagem de correção, e o `outbox_events_stalled_total` ficou em 0. Sobre a ordem: o `audited_events_out_of_order_total` ficou em 0 nos 11 processos, mas isso cobre só os eventos **já auditados**. No fim, o auditor ainda tinha ~84 mil eventos na fila (abaixo).
- **Melhoria possível, não feita:** pegar, por ciclo, os N primeiros eventos de cada wallet e publicá-los em ordem. Muda a D20.3, então seria uma decisão nova.

### Auditor de instância única

- O `event-auditor` (uma instância, D7.4) consome ~11 a 15 eventos/s nas rodadas finais: uma transação com fsync por evento.
- O publisher solta centenas de eventos por segundo, então a fila do auditor cresce durante toda a execução.
- O atraso dele **não afeta a correção**: ele só confere a ordem e registra (D20).
- Ele afeta as medições, porque disputa o WAL. Por isso a fila dele aparece antes de cada passo (D26.13).
- **Melhoria possível, não feita:** commits em lote no auditor, ou mais instâncias (a fila é FIFO por wallet). Seria uma decisão nova.

### nginx: o teto que a carga encontrou

- Na 2ª rodada de desenvolvimento, o nginx respondeu `500` sem corpo da api: 9 294 respostas no A 400/s e 5 418 no B 100/s. O log dele dizia "512 worker_connections are not enough", o padrão.
- Sem keepalive no upstream, cada requisição ocupa 2 conexões, então o teto era de ~256 simultâneas.
- **Corrigido** com `worker_connections 4096` (D26.10). Nas rodadas finais, **zero inesperados**, inclusive a 400 req/s.
- O keepalive no upstream ficou de fora de propósito: com `POST`, cria um `502` numa conexão reaproveitada que a api já fechou (`nginx/README.md`).

### Fila (D)

- 2 000 mensagens em ~79 s (~25 por segundo), com p50 de ~92 ms no consumidor: de novo, o commit com fsync.
- A FIFO limita o paralelismo a um grupo em andamento por wallet (100 grupos), com 3 consumidores de lote 10.
- Inbox, transações e DLQ conferem nas 3 rodadas.

## Limites do experimento

- **Uma máquina só.** O k6, os 11 processos, o Postgres, o LocalStack e o Keycloak dividem a mesma VM de 16 CPUs. Os números servem para comparar degraus e cenários entre si, não como capacidade de produção.
- **Disco do Docker Desktop.** O fsync de ~50 ms domina a latência de commit e o teto da hot wallet. Num disco de servidor, os números seriam outros, e a hot wallet subiria muito.
- **LocalStack não é o SQS/SNS da AWS.** As latências e as cotas de FIFO reais são outras. O envio do D usa um atalho que só existe no LocalStack (D26.9).
- **Percentis do servidor por buckets.** A espera do lock e o processamento são estimativas, com erro do tamanho do bucket (por exemplo, "> 10 000 ms" quer dizer acima do maior bucket).
- **Degraus de 30 s.** O p99 do degrau mais lento (B 10/s) tem ~290 amostras. Com 60 s, as 3 rodadas levariam ~2h10 (D26.2).
- **Chegadas descartadas no A 400/s.** Cerca de 3 500 a 4 000 chegadas por rodada não foram enviadas, por falta de VU. A latência medida é a das que foram, então um cliente que de fato mandasse todas veria filas maiores.
- **Banco não recriado** (acima): a execução começou com dados das anteriores. A correção é isolada pelos prefixos; as medições podem ter um pouco mais de custo de índice e a fila inicial do auditor.
- **Auditor como contaminação** (acima), e o teto de 180 s da espera da outbox, que o B 100/s atingiu na rodada 2 sem efeito na correção.
- **Variação entre rodadas.** O p99 do A 200/s variou de 199 a 778 ms, e o lag do A 400/s de 62 a 125 s: picos isolados, provavelmente da VM compartilhada. Os p50 e as vazões ficaram estáveis (variação abaixo de 10%).

## Como reproduzir

```bash
bun run infra:test:down       # o test:load aborta com o Compose de teste no ar (D26.8)
bun run infra:down -v         # estado limpo (banco e filas); opcional, os prefixos isolam a correção
bun run infra:up
bun run test:load             # 3 rodadas, ~1h30; relatório em logs/load/<execução>/report.md
```

Para investigar um cenário só: `bun run test:load --rounds 1 --scenarios B` (D26.12).
