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
