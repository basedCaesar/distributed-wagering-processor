# shared — aws

Clientes da AWS (LocalStack no desenvolvimento e nos testes).

| Arquivo | O que é |
|---|---|
| `sqs-client.ts` | `createSqsClient` (região e endpoint da config; credenciais estáticas, porque o LocalStack não as valida) e `queueUrlOf` (nome da fila → URL, resolvido na subida do processo). Usado pelo consumidor (D8) e pelo auditor (D20.2). |
| `sns-client.ts` | `createSnsClient` com `requestTimeout` dado e `maxAttempts: 1` (a repetição é do publisher; o timeout fica abaixo do lease, D20.5) e `topicArnOf` (nome do tópico → ARN pela listagem, na subida, D20.9). Usado pelo publisher da outbox. |

O health check do SQS (`shared/health/sqs-health-check.ts`) cria o próprio cliente, com `maxAttempts: 1` e timeout de 1 s (D11.3).
