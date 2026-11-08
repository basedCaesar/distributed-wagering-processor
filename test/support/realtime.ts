import { ListSubscriptionsByTopicCommand, PublishCommand, SNSClient, SubscribeCommand } from "@aws-sdk/client-sns";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueDoesNotExist,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { configureRealtimeApp } from "../../src/app/configure-realtime-app";
import { RealtimeAppModule } from "../../src/app/realtime.module";
import {
  instanceQueueName,
  REALTIME_CONFIG,
  type RealtimeConfig,
} from "../../src/modules/realtime/infra/realtime-config";
import type { AuthConfig } from "../../src/shared/auth/auth.config";
import type { TestIssuer } from "./auth";
import { authEnv, freePort, type ProcessGroup, type TestProcess } from "./processes";

const region = process.env.AWS_REGION ?? "us-east-1";
const endpoint = process.env.AWS_ENDPOINT ?? "http://localhost:4567";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };
const sns = new SNSClient({ region, endpoint, credentials });
const sqs = new SQSClient({ region, endpoint, credentials });

/** Um id de instância único por teste (D28.14 b: dois processos com o mesmo id dividem a fila). */
export const newInstanceId = (): string => `rt-test-${Bun.randomUUIDv7().slice(-12)}`;

/**
 * O que o `localstack-init.sh` faz para `realtime-1`/`realtime-2` (D28.5),
 * para uma instância de teste: a fila FIFO (retenção 300 s, visibilidade
 * 30 s) assinada no tópico do teste com `RawMessageDelivery`. Idempotente.
 */
export async function provisionInstanceQueue(topicArn: string, instanceId: string): Promise<string> {
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: instanceQueueName(instanceId),
      Attributes: { FifoQueue: "true", MessageRetentionPeriod: "300", VisibilityTimeout: "30" },
    }),
  );
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }));
  await sns.send(
    new SubscribeCommand({
      TopicArn: topicArn,
      Protocol: "sqs",
      Endpoint: Attributes?.QueueArn,
      Attributes: { RawMessageDelivery: "true" },
    }),
  );
  return QueueUrl as string;
}

export interface TestRealtime {
  app: INestApplication;
  /** `ws://127.0.0.1:<porta>/realtime`. */
  url: string;
  instanceId: string;
  queueName: string;
  /** Para a instância (o mesmo shutdown do SIGTERM). A fila e a assinatura ficam (D28.5). */
  close(): Promise<void>;
}

export interface TestRealtimeOptions {
  auth: AuthConfig;
  instanceId?: string;
  /** Com o tópico, a fila da instância é criada e assinada antes (o papel da infra). */
  topicArn?: string;
  overrides?: Partial<RealtimeConfig>;
}

/** A config da instância de teste: a do processo, com a porta e o `/metrics` em portas livres. */
export function testRealtimeConfig(options: TestRealtimeOptions & { instanceId: string }): RealtimeConfig {
  return {
    instanceId: options.instanceId,
    port: 0,
    metricsPort: 0,
    aws: { region, endpoint },
    auth: options.auth,
    authTimeoutMs: 5000,
    maxFollowsPerConnection: 50,
    pingIntervalMs: 30_000,
    receiveWaitSeconds: 2,
    ...options.overrides,
  };
}

/**
 * Sobe o realtime real (`RealtimeAppModule`) no processo do teste, contra
 * o LocalStack de teste. Só a config muda: o emissor de token é o de teste
 * (D10.3) e as portas são livres.
 */
export async function startTestRealtime(options: TestRealtimeOptions): Promise<TestRealtime> {
  const instanceId = options.instanceId ?? newInstanceId();
  if (options.topicArn !== undefined) await provisionInstanceQueue(options.topicArn, instanceId);
  const config = testRealtimeConfig({ ...options, instanceId });
  const moduleRef = await Test.createTestingModule({ imports: [RealtimeAppModule] })
    .overrideProvider(REALTIME_CONFIG)
    .useValue(config)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureRealtimeApp(app);
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  if (typeof address === "string" || address === null) throw new Error("endereço HTTP inesperado em teste");
  return {
    app,
    url: `ws://127.0.0.1:${address.port}/realtime`,
    instanceId,
    queueName: instanceQueueName(instanceId),
    close: () => app.close(),
  };
}

/**
 * O processo `realtime` de produção (`main-realtime.ts`), separado (D28.11),
 * com id único, porta livre e a fila assinada no tópico do teste. Pronto
 * quando loga `realtime iniciado` (depois de resolver a fila e do `listen`).
 */
export async function spawnRealtime(
  group: ProcessGroup,
  options: { topicArn: string; issuer: TestIssuer; instanceId?: string; env?: Record<string, string> },
): Promise<{ process: TestProcess; url: string; instanceId: string }> {
  const instanceId = options.instanceId ?? newInstanceId();
  await provisionInstanceQueue(options.topicArn, instanceId);
  const port = await freePort();
  const process = await group.spawn("realtime", {
    instance: instanceId,
    env: {
      ...authEnv(options.issuer),
      REALTIME_INSTANCE_ID: instanceId,
      REALTIME_PORT: String(port),
      ...options.env,
    },
  });
  return { process, url: `ws://127.0.0.1:${port}/realtime`, instanceId };
}

/** URL da fila de uma instância, ou `undefined` se ela não existe. */
export async function instanceQueueUrl(instanceId: string): Promise<string | undefined> {
  try {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: instanceQueueName(instanceId) }));
    return QueueUrl;
  } catch (error) {
    if (error instanceof QueueDoesNotExist) return undefined;
    throw error;
  }
}

/** Apaga a fila de uma instância de teste (o realtime nunca apaga a própria, D28.5). */
export async function deleteInstanceQueue(instanceId: string): Promise<void> {
  const url = await instanceQueueUrl(instanceId);
  if (url !== undefined) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
}

/** Assinaturas do tópico que entregam na fila da instância. */
export async function instanceSubscriptions(topicArn: string, instanceId: string): Promise<string[]> {
  const url = await instanceQueueUrl(instanceId);
  if (url === undefined) return [];
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["QueueArn"] }));
  const queueArn = Attributes?.QueueArn;
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, NextToken: nextToken }));
    for (const subscription of page.Subscriptions ?? []) {
      if (subscription.Endpoint === queueArn && subscription.SubscriptionArn) arns.push(subscription.SubscriptionArn);
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return arns;
}

/** Envelope do §11 de um `WalletBalanceChanged` (D9.4), como o publisher enviaria. */
export function balanceChangedEnvelope(walletId: string, walletVersion: number, eventId = Bun.randomUUIDv7()) {
  return {
    eventId,
    eventType: "WalletBalanceChanged",
    aggregateId: walletId,
    correlationId: `corr-${eventId}`,
    occurredAt: new Date().toISOString(),
    version: 1,
    data: {
      walletId,
      transactionId: Bun.randomUUIDv7(),
      direction: "CREDIT",
      money: { amount: "1.00", currency: "BRL" },
      balanceBefore: { amount: `${walletVersion - 1}.00`, currency: "BRL" },
      balanceAfter: { amount: `${walletVersion}.00`, currency: "BRL" },
      walletVersion,
    },
  };
}

/** Publica um envelope direto no tópico do teste, com o grupo e a deduplicação do publisher (D9.1). */
export async function publishEnvelope(topicArn: string, envelope: { eventId: string; data: { walletId: string } }): Promise<void> {
  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Message: JSON.stringify(envelope),
      MessageGroupId: envelope.data.walletId,
      MessageDeduplicationId: envelope.eventId,
    }),
  );
}
