import type { SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Module, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Logger } from "pino";
import { JoseProviderIdentity } from "../../../shared/auth/jose-provider-identity";
import { PROVIDER_IDENTITY } from "../../../shared/auth/provider-identity.port";
import { createSqsClient } from "../../../shared/aws/sqs-client";
import { LOGGER } from "../../../shared/logger/logger.module";
import { metricsRegistry } from "../../../shared/metrics/metrics";
import { MetricsServer } from "../../../shared/metrics/metrics-server";
import { RealtimeHub } from "../application/realtime-hub";
import { logDeliveryFailure } from "./delivery-failure";
import { resolveInstanceQueueUrl } from "./messaging/instance-queue";
import { RealtimeEventLoop } from "./messaging/realtime-event-loop";
import { instanceQueueName, loadRealtimeConfig, REALTIME_CONFIG, type RealtimeConfig } from "./realtime-config";
import { RealtimeGateway } from "./ws/realtime.gateway";

const SQS = Symbol("REALTIME_SQS");
/** A fila da instância, resolvida na subida, e o horário de início (D28.5, D28.6). */
const INSTANCE_QUEUE = Symbol("REALTIME_INSTANCE_QUEUE");

interface InstanceQueue {
  queueUrl: string;
  startedAt: number;
}

/**
 * Subida e parada do processo (D28.5). A fila é resolvida na fábrica do
 * `INSTANCE_QUEUE`, antes do `listen`; o laço começa no bootstrap. No stop:
 * sockets com `1001`, laço parado (o long poll termina, D19.9), métricas e
 * cliente fechados. A assinatura e a fila são da infra e ficam.
 */
class RealtimeLifecycle implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(
    @Inject(RealtimeEventLoop) private readonly loop: RealtimeEventLoop,
    @Inject(RealtimeGateway) private readonly gateway: RealtimeGateway,
    @Inject(MetricsServer) private readonly metrics: MetricsServer,
    @Inject(REALTIME_CONFIG) private readonly config: RealtimeConfig,
    @Inject(SQS) private readonly sqs: SQSClient,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.metrics.start(this.config.metricsPort);
    this.loop.start();
  }

  async onModuleDestroy(): Promise<void> {
    const closed = this.gateway.closeAll();
    await this.loop.stop();
    await this.metrics.stop();
    this.sqs.destroy();
    this.logger.info({ instanceId: this.config.instanceId, closedConnections: closed }, "realtime parado");
  }
}

/** Contexto `realtime` no processo `realtime` (D28.1, D28.11): sem banco e sem SNS. */
@Module({
  providers: [
    { provide: REALTIME_CONFIG, useFactory: () => loadRealtimeConfig() },
    {
      provide: PROVIDER_IDENTITY,
      useFactory: (config: RealtimeConfig) => new JoseProviderIdentity(config.auth),
      inject: [REALTIME_CONFIG],
    },
    {
      provide: RealtimeHub,
      useFactory: (config: RealtimeConfig, logger: Logger) =>
        new RealtimeHub({ maxFollowsPerConnection: config.maxFollowsPerConnection, onDeliveryFailure: logDeliveryFailure(logger) }),
      inject: [REALTIME_CONFIG, LOGGER],
    },
    { provide: SQS, useFactory: (config: RealtimeConfig) => createSqsClient(config.aws), inject: [REALTIME_CONFIG] },
    {
      provide: INSTANCE_QUEUE,
      useFactory: async (config: RealtimeConfig, sqs: SQSClient): Promise<InstanceQueue> => {
        // Antes de olhar a fila: nada enviado depois da subida é descartado (D28.6).
        const startedAt = Date.now();
        return { queueUrl: await resolveInstanceQueueUrl(sqs, instanceQueueName(config.instanceId)), startedAt };
      },
      inject: [REALTIME_CONFIG, SQS],
    },
    {
      provide: RealtimeEventLoop,
      useFactory: (config: RealtimeConfig, sqs: SQSClient, queue: InstanceQueue, hub: RealtimeHub, logger: Logger) =>
        new RealtimeEventLoop({
          sqs,
          queueUrl: queue.queueUrl,
          hub,
          logger,
          startedAt: queue.startedAt,
          receiveWaitSeconds: config.receiveWaitSeconds,
        }),
      inject: [REALTIME_CONFIG, SQS, INSTANCE_QUEUE, RealtimeHub, LOGGER],
    },
    {
      provide: MetricsServer,
      useFactory: (logger: Logger) => new MetricsServer(metricsRegistry, logger),
      inject: [LOGGER],
    },
    RealtimeGateway,
    RealtimeLifecycle,
  ],
})
export class RealtimeModule {}
