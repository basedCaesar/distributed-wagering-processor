# nginx

Balanceador das 3 instâncias da `api` no Compose de dev (D7.4). É a única porta da api para fora (`localhost:3000`), para os `curl` do §9.

| Arquivo | O que é |
|---|---|
| `nginx.conf` | O `upstream` com `api-1..3`, os prazos e a regra de repetição. |

## Regras

- **Versão exata da imagem: `nginx:1.27.5-alpine`.** O `upstream` usa `server api-N:3000 resolve`, para que uma `api` reiniciada com outro IP volte a receber tráfego (DNS do Docker, `resolver 127.0.0.11`). O parâmetro `resolve` no `upstream` só existe no nginx open source **a partir da 1.27.3**. Conferido em 01/11/2026: com a 1.27.2, o `nginx -t` falha com `invalid parameter "resolve"`; com a 1.27.5, passa. Uma tag flutuante (`1.27-alpine`) funcionaria hoje, mas não fixa esse mínimo. O teste `test/integration/infra/compose-topology.spec.ts` exige uma versão exata ≥ 1.27.3.
- **Não roteia pela readiness** (D5, B7.7): o tráfego continua com o SQS fora.
- **Só repete o que não chegou à api** (`proxy_next_upstream error`, sem `non_idempotent`): um `POST` que já chegou nunca é repetido pelo nginx. Quem reenvia é o provedor, com a mesma `Idempotency-Key` (D3.4).
- **Prazo de leitura de 15 s**, acima dos 10 s da requisição na api (D21.3): o `503` da api chega antes do `504` do nginx.
- **`worker_connections 4096`** (D26.10). O teste de carga encontrou o teto do padrão, 512: a 400 req/s (cenário A) e na hot wallet a 100 req/s (cenário B), o nginx respondeu `500` sem corpo da api ("512 worker_connections are not enough while connecting to upstream"). Foram 9 294 respostas no A 400/s e 1 543 linhas logadas no B 100/s. Sem keepalive no upstream, cada requisição em andamento ocupa 2 conexões, então o teto era de ~256 requisições simultâneas. Com 4096, são ~2048, acima das 1 200 conexões do maior passo do k6 (600 VUs).
- **Sem keepalive no upstream, de propósito** (D26.10). Reaproveitar as conexões nginx → api pouparia o handshake TCP a cada requisição, mas cria um modo de falha novo: se a api fechar uma conexão ociosa no mesmo instante em que o nginx a reaproveita para um `POST`, o nginx não repete o `POST` (não é idempotente) e devolve `502` ao provedor. Evitar isso exige alinhar o timeout de keepalive do nginx (`keepalive_timeout` do upstream) abaixo do do servidor HTTP da api, e testar a corrida. Fica como melhoria possível.
