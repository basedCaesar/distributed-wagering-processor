import { z } from "zod";
import { ConfigValidationError } from "../config/config";

export const AUTH_CONFIG = Symbol("AUTH_CONFIG");

/**
 * Emissor dos tokens (D10.1). Só o processo `api` lê: a fila não tem auth
 * (R-02-07), então consumidor e workers não precisam destas variáveis.
 * Não há chave para desligar a validação (D10.3).
 */
export const authConfigSchema = z.object({
  issuer: z.string().min(1),
  audience: z.string().min(1),
  jwksUrl: z.url(),
  /** JWKS sem resposta nesse prazo → `503` (D16.16). */
  jwksTimeoutMs: z.coerce.number().int().positive().default(5000),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;

export function loadAuthConfig(
  env: Record<string, string | undefined> = process.env,
): AuthConfig {
  const parsed = authConfigSchema.safeParse({
    issuer: env.AUTH_ISSUER,
    audience: env.AUTH_AUDIENCE,
    jwksUrl: env.AUTH_JWKS_URL,
    jwksTimeoutMs: env.AUTH_JWKS_TIMEOUT_MS,
  });
  if (!parsed.success) throw new ConfigValidationError(parsed.error.message);
  return parsed.data;
}
