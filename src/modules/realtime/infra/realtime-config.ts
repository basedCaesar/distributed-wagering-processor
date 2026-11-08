import { z } from "zod";
import { authConfigSchema } from "../../../shared/auth/auth.config";
import { ConfigValidationError } from "../../../shared/config/config";

export const REALTIME_CONFIG = Symbol("REALTIME_CONFIG");

/**
 * Id estável da instância (D28.5): vira o nome da fila. Minúsculas,
 * dígitos e hífen; até 40 caracteres, para a fila caber nos 80 do SQS.
 */
const INSTANCE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const schema = z.object({
  instanceId: z.string().regex(INSTANCE_ID, "REALTIME_INSTANCE_ID fora do formato (D28.5)"),
  port: z.coerce.number().int().min(0).max(65_535).default(3001),
  /** Porta interna do `/metrics` (D22.1); `0` = livre (testes). */
  metricsPort: z.coerce.number().int().min(0).max(65_535).default(9464),
  aws: z.object({ region: z.string().min(1), endpoint: z.string().min(1) }),
  auth: authConfigSchema,
  /** Prazo do 1º frame (`auth`), D28.2. */
  authTimeoutMs: z.coerce.number().int().positive().default(5000),
  maxFollowsPerConnection: z.coerce.number().int().positive().default(50),
  pingIntervalMs: z.coerce.number().int().positive().default(30_000),
  /** Long poll do receive (D19.10); o stop não o aborta: ele termina, e o que trouxer é apagado sem envio (D28.5). */
  receiveWaitSeconds: z.coerce.number().int().min(1).max(20).default(20),
});

export type RealtimeConfig = z.infer<typeof schema>;

/**
 * Config própria e mínima do realtime (D28.11): sem banco, sem as filas do
 * núcleo e sem o tópico (a assinatura é da infra, D28.5); não carrega a
 * config comum. Falha na subida se faltar algo.
 */
export function loadRealtimeConfig(env: Record<string, string | undefined> = process.env): RealtimeConfig {
  const parsed = schema.safeParse({
    instanceId: env.REALTIME_INSTANCE_ID,
    port: env.REALTIME_PORT,
    metricsPort: env.METRICS_PORT,
    aws: { region: env.AWS_REGION, endpoint: env.AWS_ENDPOINT },
    auth: {
      issuer: env.AUTH_ISSUER,
      audience: env.AUTH_AUDIENCE,
      jwksUrl: env.AUTH_JWKS_URL,
      jwksTimeoutMs: env.AUTH_JWKS_TIMEOUT_MS,
    },
    authTimeoutMs: env.REALTIME_AUTH_TIMEOUT_MS,
    maxFollowsPerConnection: env.REALTIME_MAX_FOLLOWS,
    pingIntervalMs: env.REALTIME_PING_INTERVAL_MS,
    receiveWaitSeconds: env.REALTIME_RECEIVE_WAIT_S,
  });
  if (!parsed.success) throw new ConfigValidationError(parsed.error.message);
  return parsed.data;
}

/** A fila da instância (D28.5). O prefixo `realtime-` evita colidir com as filas do auditor e do accounting. */
export function instanceQueueName(instanceId: string): string {
  return `wagering-events-realtime-${instanceId}.fifo`;
}
