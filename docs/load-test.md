# Teste de carga

Diferencial do §14 (R-14-O1): `bun run test:load`, decidido na D26. Este documento traz os números reais de uma execução de 3 rodadas na máquina de desenvolvimento, em 08/11/2026, e a análise deles. O relatório gerado dessa execução está em `logs/load/20261108T040046/report.md`, fora do git. Como o teste funciona: [`load/README.md`](../load/README.md).

**Não há meta de RPS** (§14). O teste reprova só pela correção depois da carga ou por status inesperado, nunca por latência (D26.6).

## Resumo

- **Correção: passou nas 3 rodadas.** Em cada uma:
  - as 314 wallets da rodada reconciliadas com `consistent: true`;
  - nenhum saldo negativo;
  - saldo = soma das transações `PROCESSED`;
  - nenhuma transação `PROCESSED` sem lançamento no ledger, nenhum lançamento órfão;
  - cada operação confirmada (`200`/`422`) está no banco;
  - duplicatas: exatamente 1 transação por key;
  - fila: 2 000 mensagens, 2 000 linhas na inbox, 2 000 transações, nada na DLQ;
  - **zero status inesperados**.
- **Muitas wallets:** escala linearmente até 200 req/s, com p99 de 283 a 608 ms. Satura em **260 a 276 resoluções/s**. A 400 req/s, o p50 passa de 2 s e o k6 deixa de iniciar ~4 000 chegadas por falta de VU. A espera do lock continua na casa dos milissegundos: o gargalo não é o lock da wallet.
- **Hot wallet:** **~10 a 13 transações/s**, qualquer que seja a taxa pedida. O lock pessimista serializa a wallet por desenho (D7.2), e cada transação segura o lock até o commit, que espera o fsync do WAL. Neste disco (o do Docker Desktop no WSL2), cada fsync leva perto de 50 ms.
- **Outbox:** sob carga, o publisher fica para trás e alcança depois, sem perder nem reordenar nada:
  - muitas wallets: lag máximo de 33 a 84 s a 200 req/s, e de 55 a 134 s a 400 req/s;
  - hot wallet: 80 a 170 s, porque uma wallet publica um evento por ciclo (D9.2, D20.3).
- **Achados corrigidos durante a fatia:** o teto de 512 conexões do nginx (D26.10). **Achados documentados, sem mudança:**
  - o fsync limitando a hot wallet (`synchronous_commit` mantido);
  - a vazão por wallet da outbox;
  - o auditor de instância única, a ~12 a 13 eventos/s.

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
| Commit medido | `2447289` com as mudanças da S13 ainda não commitadas (este commit) |
| Execução | `20261108T040046`, de 04:00:46 a 05:27:57 UTC (1h27), 3 rodadas, todos os cenários |
| Estado inicial | Compose de dev recriado do zero (`bun run infra:down -v` + `bun run infra:up`) antes das rodadas |

## Metodologia

Resumo da D26. Detalhes em `docs/02-decisoes.md`, D26.1 a D26.13.

- **Cliente:** k6 num container na rede do Compose, chamando o `nginx:80` e lendo o `/metrics` interno de cada processo (D22.1) sem porta exposta.
- **Modelo aberto** (`constant-arrival-rate`): as chegadas não esperam a resposta anterior, então a lentidão do servidor não esconde a própria latência. Chegada que o k6 não consegue iniciar por falta de VU (teto de 600) aparece como **descartada**; essas requisições nunca foram enviadas.
- **Cenários:**

  | Cenário | O que roda |
  |---|---|
  | Aquecimento | 25 req/s por 15 s, descartado |
  | A | 200 wallets, 70% BET e 30% WIN sem referência, chaves únicas; degraus de 50, 100, 200 e 400 req/s, **30 s cada** |
  | B | uma wallet nova por degrau, com saldo para 70% das BETs previstas; degraus de 10, 25, 50 e 100 req/s, 30 s cada |
  | C | 50 keys × 20 cópias quase simultâneas, em 10 wallets |
  | D | 2 000 mensagens do §10 em 100 wallets (`MessageGroupId` = walletId), por `SendMessageBatch` direto no LocalStack (atalho só dele, D26.9) |

- **`503`:** o cliente reenvia com a mesma key, respeitando o `Retry-After`, até 5 tentativas (D26.5).
  - **Taxa de erro** = (desistências + inesperados) / operações.
  - **Latência por tentativa:** cada requisição.
  - **Latência por operação:** inclui as esperas dos reenvios.
- **Métricas do servidor:** diferença do `/metrics` antes e depois de cada passo, somada entre as instâncias. A espera do lock (`wallet_lock_wait_seconds`) e a latência de processamento (`wagering_processing_duration_seconds`, em volta do use case) são **percentis estimados pelos buckets**, com erro do tamanho do bucket. Os do k6 usam todas as amostras.
- **Outbox lag:** o `outbox_lag_seconds` dos 2 publishers, lido a cada 1 s durante o passo e depois dele, até a outbox esvaziar (teto de 180 s).
- **Repouso antes de cada passo** (D26.11): outbox vazia, nenhuma sessão da app ativa no banco e os `_count` parados entre duas leituras. Nas 3 rodadas, todo passo entrou em repouso na 2ª leitura (16 a 37 s, só o custo de medir).
  - O `event-auditor` fica fora da condição (D26.13): a fila dele antes de cada passo é registrada como **contaminação conhecida**.
- **Tokens:** um por passo, pedido fora da medição (D26.3). Foram 36 pedidos na execução inteira, nenhum durante uma janela medida, então o Keycloak não pesou nos números.

## Resultados

Os números das 3 rodadas aparecem lado a lado (r1 / r2 / r3). Latência HTTP por tentativa, do k6.

### A: muitas wallets em paralelo

| Degrau | Resolvidas/s | p50 | p95 | p99 | Descartadas (k6) | `503` | Inesperados |
|---|---|---|---|---|---|---|---|
| 50/s | 50,0 / 50,0 / 50,0 | 91 / 92 / 89 ms | 135 / 139 / 139 ms | 160 / 177 / 216 ms | 0 | 0 | 0 |
| 100/s | 100,0 / 100,0 / 100,0 | 89 / 90 / 90 ms | 162 / 150 / 149 ms | 561 / 235 / 195 ms | 0 | 0 | 0 |
| 200/s | 200,0 / 200,0 / 200,0 | 107 / 99 / 95 ms | 376 / 220 / 170 ms | 608 / 360 / 283 ms | 0 | 0 | 0 |
| 400/s | **263 / 260 / 276** | 2 186 / 2 350 / 2 268 ms | 3 303 / 2 934 / 2 708 ms | 3 510 / 3 182 / 2 832 ms | 4 101 / 4 201 / 3 727 | 0 | 0 |

**No servidor** (buckets):

| Degrau | Espera do lock p99 | Processamento p50 (http) | Processamento p95 |
|---|---|---|---|
| 50/s | 4,1 / 4,8 / 4,7 ms | 87 / 88 / 85 ms | 227 / 229 / 228 ms |
| 200/s | 4,8 / 4,8 / 4,8 ms | 117 / 97 / 92 ms | 407 / 245 / 236 ms |
| 400/s | 15,5 / 31,8 / 9,2 ms | 2 048 / 2 122 / 1 926 ms | 4 590 / 4 631 / 4 483 ms |

Nenhum conflito de lock no A.

**Outbox:**

| Degrau | Lag máximo | Pendentes no pico | Esvaziou em |
|---|---|---|---|
| 50/s | 1,5 / 1,2 / 3,4 s | 107 / 80 / 290 | 1,0 / 1,0 / 1,0 s |
| 100/s | 3,9 / 10,7 / 15,4 s | 708 / 2 080 / 1 878 | 4,0 / 9,1 / 15,1 s |
| 200/s | 82,5 / 83,7 / 33,4 s | 10 905 / 11 103 / 7 243 | 83,2 / 84,4 / 34,3 s |
| 400/s | 62,0 / 55,4 / 133,5 s | 12 511 / 10 736 / 16 253 | 62,3 / 55,6 / 134,1 s |

"Esvaziou em" conta a partir do fim da carga do degrau.

### B: uma hot wallet disputada

| Degrau | Resolvidas/s | p50 | p99 | `503` (tentativas) | Desistências | Taxa de erro | Descartadas |
|---|---|---|---|---|---|---|---|
| 10/s | 9,6 / 9,5 / 9,6 | 490 / 546 / 565 ms | 5,0 s | 31 / 45 / 31 | 0 | 0% | 13 / 16 / 12 |
| 25/s | 11,7 / 11,5 / 11,7 | 7,0 a 7,5 s | 10,0 s | 82 / 125 / 110 | 0 | 0% | ~400 |
| 50/s | 12,7 / 12,4 / 12,8 | 10,0 s | 10,0 s | 523 / 503 / 549 | 0 | 0% | ~1 120 |
| 100/s | 7,7 / 9,0 / 7,7 | 10,0 s | 10,0 s | 1 688 / 1 731 / 1 587 | 166 / 156 / 156 | **30,1% / 28,5% / 30,5%** | ~2 450 |

- **Espera do lock** (buckets):
  - p50 de 340 a 384 ms a 10/s, e de 2,9 a 3,2 s acima disso;
  - p95 de 3,6 a 4,8 s;
  - conflitos `lock_timeout` de 3 a 36 por degrau.
- **Processamento:** p50 de 496 a 633 ms a 10/s; acima de 10 s nos degraus mais altos.
- **Replays:** de 39 a 269 por degrau, com chaves únicas. São reenvios depois de um `503` de prazo da requisição (10 s, D21.3) cuja 1ª tentativa commitou depois, e o reenvio caiu no replay (D3.4).
- **Rejeições:** no B 10/s, exatamente 210 `PROCESSED` em cada rodada (o saldo cobria 70% das 300 BETs previstas) e 75 a 79 `REJECTED` com `INSUFFICIENT_FUNDS`, como planejado.
- **Outbox da hot wallet:** lag máximo de 80 a 170 s. No B 100/s das rodadas 1 e 2, ela não esvaziou dentro dos 180 s do teardown do passo. Esvaziou antes do passo seguinte (o repouso exige isso) e antes da checagem de correção.

### C: duplicatas da mesma key

Em cada rodada:
- 1 000 envios: **50 respostas originais e 950 replays**, nenhum `409`, nenhum `503`;
- no banco, 50 transações para 50 keys;
- p50 de 3,7 a 4,3 ms (o replay é só leitura) e p99 de 2,25 a 2,30 s;
- espera do lock com p95 de 3,2 a 3,9 s: as 20 cópias de cada key esperam o lock da mesma wallet (D3.6).

### D: mensagens pela fila

| | r1 | r2 | r3 |
|---|---|---|---|
| Fila vazia em | 79,0 s | 76,8 s | 77,9 s |
| Mensagens/s | 25,3 | 26,1 | 25,7 |
| Processamento no consumidor p50 / p99 | 96 / 353 ms | 91 / 328 ms | 94 / 248 ms |
| Inbox / transações / DLQ | 2 000 / 2 000 / 0 | 2 000 / 2 000 / 0 | 2 000 / 2 000 / 0 |

### Fila do auditor (contaminação conhecida, D26.13)

- A fila do `event-auditor` cresceu de 0, antes do A da rodada 1, para ~90 mil mensagens, antes do B da rodada 3.
- Vazão medida durante os repousos: **11,3 a 13,5 eventos/s**.
- Em alguns repousos a vazão saiu negativa (−2,6 e −3,6/s): ainda entravam eventos na fila, então essa leitura é a variação líquida.
- Durante todos os passos, o auditor estava trabalhando e disputando o WAL do Postgres. Nos 11 processos, `audited_events_out_of_order_total` e `reconciliation_divergences_total` ficaram em 0 no fim da execução.

## Análise

### Muitas wallets: onde satura

- Até 200 req/s, a vazão acompanha a taxa pedida sem erro, com p50 estável em ~90 a 107 ms.
- A 400 req/s, satura em 260 a 276 resoluções/s. A latência no servidor sobe para ~2 s, e o k6 esgota os 600 VUs: cerca de um terço das chegadas não chega a ser enviado.
- A **espera do lock não muda** (p99 abaixo de 32 ms): não há disputa entre wallets, como esperado (sem lock global, D7).
- O tempo vai para dentro da api e do banco. Não isolei qual recurso satura primeiro. Os candidatos:
  - o commit (WAL compartilhado, com commit em grupo);
  - o pool de conexões de cada api;
  - a CPU da VM dividida entre o k6 e os 11 processos.
- **Limite do diagnóstico:** a foto das conexões do Postgres depois do A não pegou os pools das api (as conexões ociosas já tinham sido fechadas), então ela não mede o pico.
- O p50 de ~90 ms com carga baixa já é, quase todo, o commit esperando o fsync. Veja a hot wallet, abaixo.

### Hot wallet: limitada pelo fsync do commit

- Uma wallet processa **~10 a 13 transações/s**, qualquer que seja a taxa pedida.
- É o efeito esperado do lock pessimista (D7.2): as transações da mesma wallet são serializadas, e cada uma segura o lock até o commit.
- A investigação do B isolado (sem o A antes) mostrou de onde vem o tempo com o lock segurado:
  - **`pg_stat_activity` amostrado a cada 0,2 s:** a sessão que segura o lock da hot wallet passa ~90% do tempo no `commit`, esperando `WALSync` (o fsync) ou `WALWrite` (a vez de quem faz o fsync). Foram 69 de 76 amostras da api fora da espera do lock.
  - **`pg_stat_wal`:** 190 fsyncs em 10,35 s, ~18/s, com o `WALSync` quase sempre ocupado. Isso dá perto de 50 ms por `fdatasync` neste disco (ext4 no disco virtual do WSL2, gravando no disco do Windows).
- Na hot wallet não há commit em grupo: a transação seguinte só começa depois de a anterior commitar. O teto fica em ~1 / (fsync + fila do WAL), uns 10/s.
- O auditor e o publisher também fazem commits com fsync e disputam o mesmo WAL, o que agrava.
- **O que isso causa:**
  - acima de ~10/s, as requisições esperam o lock até o `lock_timeout` de 2 s (`503`) ou o prazo da requisição de 10 s (`503`, D21.3);
  - o reenvio com a mesma key amplifica a fila: no B 100/s, 1 600 a 1 700 `503` e ~30% de desistências depois de 5 tentativas;
  - **o dinheiro continua certo:** nenhum débito duplicado, e os replays mostram que o reenvio de uma requisição que commitou depois do prazo cai no replay.
- **`synchronous_commit` não foi mexido.** Desligá-lo tiraria o fsync do caminho do commit e multiplicaria a vazão da hot wallet, mas um commit confirmado ao provedor poderia se perder numa queda do Postgres. **Não trocamos durabilidade de dinheiro por vazão.**
- **Em produção:** num disco com fsync de ~1 ms, o mesmo desenho deveria subir esse teto em cerca de uma ordem de grandeza. É uma estimativa, **não medida aqui**.
- Subir o teto da hot wallet de verdade pede outro desenho de concorrência (saldo particionado, update atômico condicionado sem o lock da linha, D7), e isso seria uma decisão nova.

### Outbox: vazão por wallet

- A garantia de ordem por wallet (D9.2) faz o claim pegar só a **cabeça** de cada wallet (D20.3, `infra/outbox/README.md`). Uma wallet publica no máximo um evento por ciclo: 1 claim commitado, 1 `Publish` e 1 commit da marcação, cada commit com o seu fsync.
- **Hot wallet:** gera ~2 eventos por transação, a ~10 tx/s. A outbox dela cresce durante o passo e leva de 80 a 170 s para esvaziar.
- **Muitas wallets:** a 200 req/s são ~400 eventos/s. O lote de 50 cabeças por ciclo e os 2 publishers não acompanham, e o lag chega a 33 a 84 s, com ~7 a 11 mil pendentes.
- **Nenhum evento ficou para trás**: a outbox esvaziou antes de cada passo e de cada checagem de correção, e o `outbox_events_stalled_total` ficou em 0. Sobre a ordem: o `audited_events_out_of_order_total` ficou em 0 nos 11 processos, mas isso cobre só os eventos **já auditados**. No fim, o auditor ainda tinha ~80 mil eventos na fila (abaixo).
- **Melhoria possível, não feita:** pegar, por ciclo, os N primeiros eventos de cada wallet e publicá-los em ordem. Muda a D20.3, então seria uma decisão nova.

### Auditor de instância única

- O `event-auditor` (uma instância, D7.4) consome ~12 a 13 eventos/s nas rodadas finais (~17/s numa medição anterior): uma transação com fsync por evento.
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

- 2 000 mensagens em ~78 s (~26 por segundo), com p50 de ~94 ms no consumidor: de novo, o commit com fsync.
- A FIFO limita o paralelismo a um grupo em andamento por wallet (100 grupos), com 3 consumidores de lote 10.
- Inbox, transações e DLQ conferem nas 3 rodadas.

## Limites do experimento

- **Uma máquina só.** O k6, os 11 processos, o Postgres, o LocalStack e o Keycloak dividem a mesma VM de 16 CPUs. Os números servem para comparar degraus e cenários entre si, não como capacidade de produção.
- **Disco do Docker Desktop.** O fsync de ~50 ms domina a latência de commit e o teto da hot wallet. Num disco de servidor, os números seriam outros, e a hot wallet subiria muito.
- **LocalStack não é o SQS/SNS da AWS.** As latências e as cotas de FIFO reais são outras. O envio do D usa um atalho que só existe no LocalStack (D26.9).
- **Percentis do servidor por buckets.** A espera do lock e o processamento são estimativas, com erro do tamanho do bucket (por exemplo, "> 10 000 ms" quer dizer acima do maior bucket).
- **Degraus de 30 s.** O p99 do degrau mais lento (B 10/s) tem ~290 amostras. Com 60 s, as 3 rodadas levariam ~2h10 (D26.2).
- **Chegadas descartadas no A 400/s.** Cerca de 4 000 chegadas por rodada não foram enviadas, por falta de VU. A latência medida é a das que foram, então um cliente que de fato mandasse todas veria filas maiores.
- **Auditor como contaminação** (acima), e o teto de 180 s do teardown, que o B 100/s atingiu em 2 rodadas sem efeito na correção.
- **Variação entre rodadas.** O p99 do A 100/s variou de 195 a 561 ms, e o lag do A 400/s de 55 a 134 s: picos isolados, provavelmente da VM compartilhada. Os p50 e as vazões ficaram estáveis (variação abaixo de 10%).

## Como reproduzir

```bash
bun run infra:test:down       # o test:load aborta com o Compose de teste no ar (D26.8)
bun run infra:down -v         # estado limpo (banco e filas)
bun run infra:up
bun run test:load             # 3 rodadas, ~1h30; relatório em logs/load/<execução>/report.md
```

Para investigar um cenário só: `bun run test:load --rounds 1 --scenarios B` (D26.12).
