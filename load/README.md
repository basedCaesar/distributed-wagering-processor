# load: teste de carga (`bun run test:load`)

Teste de carga do §14 (R-14-O1), decidido na D26. Roda contra o Compose de dev (`bun run infra:up`), **fora** do `check` e do CI (D26.8). Os números e a análise estão em [`docs/load-test.md`](../docs/load-test.md).

```bash
bun run infra:test:down       # o test:load aborta com o Compose de teste no ar (D26.8)
bun run infra:up
bun run test:load             # 3 rodadas (~1h30), o padrão do relatório
bun run test:load --rounds 1  # 1 rodada (~30 min), para iterar
bun run test:load --rounds 1 --scenarios B   # só a hot wallet, para investigar (D26.12)
```

Saída em `logs/load/<execução>/`: `report.md` (o relatório gerado), `result.json`, um `.json` e um `.k6.log` por passo, as leituras do `/metrics` antes e depois (`probe-*.json`) e os fatos da correção de cada rodada (`r<n>-facts.json`).

## Arquivos

| Arquivo | O que faz | Decisões |
|---|---|---|
| `../scripts/load-test.ts` | Orquestrador (Bun): confere o ambiente, cria as wallets, pede um token por passo, roda o k6 por passo, lê o `/metrics`, faz a checagem de correção e escreve o relatório. | D26.3, D26.6, D26.7, D26.8 |
| `k6/submit.ts` | Passo HTTP (aquecimento, A, B, C): `POST /wagering/transactions` pelo `nginx:80`, com reenvio do `503` com a mesma key; lê a outbox a cada 1 s e espera ela esvaziar no fim. | D26.2, D26.4, D26.5 |
| `k6/queue.ts` | Passo D: `SendMessageBatch` na API HTTP do SQS do LocalStack (atalho só do LocalStack), espera a fila e a outbox esvaziarem. | D26.9 |
| `k6/probe.ts` | Lê o `/metrics` interno dos 11 processos (D22.1), sem porta exposta. | D26.4 |
| `k6/common.ts` | Leitura da outbox, espera da outbox, wallets do passo, resumo em JSON. | D26.4 |
| `lib/plan.ts` | O experimento: cenários, degraus, durações, tamanhos; `--rounds`. | D26.2 |
| `lib/classify.ts` | Desfecho de cada resposta: `processed`, `rejected`, `transient` (`503`) ou `unexpected`. | D26.5 |
| `lib/prometheus.ts` | Leitura do formato do Prometheus, diferença somada entre instâncias, percentil pelos buckets. | D26.4 |
| `lib/evaluate.ts` | Veredito da rodada: só a correção e o status inesperado reprovam; latência nunca. | D26.6 |
| `lib/report.ts` | O `report.md` gerado. | D26.7 |

O `lib/` é código puro, usado pelo k6 e pelo Bun. O `k6/` tem `tsconfig` próprio (`@types/k6`), checado pelo `bun run typecheck`.

## Uma rodada

```mermaid
sequenceDiagram
    autonumber
    participant O as load-test.ts (host)
    participant KC as Keycloak
    participant K as k6 (container na rede do Compose)
    participant N as nginx → 3 api
    participant M as /metrics :9464 (11 processos)
    participant DB as Postgres

    O->>KC: token do operator
    O->>N: POST /wallets (fora da medição)
    loop cada passo (aquecimento, A×4, B×4, C, D)
        O->>KC: token do provider-a (cobre o passo, D26.3)
        O->>K: probe.ts
        K->>M: /metrics antes
        O->>K: submit.ts ou queue.ts
        K->>N: carga (taxa constante; 503 → reenvio, mesma key)
        K->>M: outbox lag a cada 1 s (2 publishers)
        K->>M: depois da carga: espera a outbox (e a fila) esvaziar
        O->>K: probe.ts
        K->>M: /metrics depois
    end
    O->>DB: outbox vazia? consultas de correção (papel da app)
    O->>N: POST /wallets/:id/reconciliation em todas as wallets da rodada
    O->>O: veredito (D26.6) e report.md
```

## Regras

- Latência nunca reprova; só a correção e o status inesperado (D26.6). Não há thresholds no k6.
- Wallets e ids externos levam o prefixo `load-<execução>-r<rodada>`; a correção olha só para eles (D26.2, como na D21.5).
- O token é passado ao container pelo ambiente, nunca na linha de comando nem no log (D11.1). Os logs do k6 só trazem status e código de erro das respostas inesperadas, nunca valores.
- Testes de unidade: `test/unit/load/` (Prometheus, classificação, plano e argumentos, veredito, relatório).
