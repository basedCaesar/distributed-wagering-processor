import {
  type CryptoKey,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  SignJWT,
} from "jose";
import type { AuthConfig } from "../../src/shared/auth/auth.config";

const KID = "test-key";
const ISSUER = "https://issuer.test.local/realms/wagering";
const AUDIENCE = "wagering-api";

export interface TokenOptions {
  /** Papéis em `realm_access.roles` (D16.1). */
  roles?: string[];
  /** `provider_id`; `null` omite o claim. */
  providerId?: string | null;
  issuer?: string;
  audience?: string;
  /** Segundos até expirar; negativo gera um token já vencido. */
  expiresIn?: number;
  /** Assina com uma chave que o JWKS não publica (mesmo `kid`). */
  foreignKey?: boolean;
  /** Assina com HS256 em vez de RS256. */
  hs256?: boolean;
}

export interface TestIssuer {
  config: AuthConfig;
  token(options?: TokenOptions): Promise<string>;
  operatorToken(): Promise<string>;
  providerToken(providerId?: string): Promise<string>;
  stop(): Promise<void>;
}

/**
 * Emissor de teste (D10.3): um par RSA e um JWKS servido por HTTP de
 * verdade. A API valida com o mesmo adaptador `jose` da produção; só a URL
 * do JWKS muda.
 */
export async function startTestIssuer(): Promise<TestIssuer> {
  const own = await generateKeyPair("RS256", { extractable: true });
  const foreign = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(own.publicKey)),
    kid: KID,
    alg: "RS256",
    use: "sig",
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ keys: [jwk] }),
  });

  async function token(options: TokenOptions = {}): Promise<string> {
    const payload: JWTPayload = {
      realm_access: { roles: options.roles ?? ["provider"] },
    };
    const providerId =
      options.providerId === undefined ? "provider-a" : options.providerId;
    if (providerId !== null) payload.provider_id = providerId;

    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT(payload)
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? AUDIENCE)
      .setSubject("service-account-test")
      .setIssuedAt(now - 60)
      .setExpirationTime(now + (options.expiresIn ?? 300));

    if (options.hs256) {
      return jwt
        .setProtectedHeader({ alg: "HS256", kid: KID })
        .sign(new TextEncoder().encode("a-shared-secret-of-32-bytes-long!"));
    }
    const key: CryptoKey = options.foreignKey
      ? foreign.privateKey
      : own.privateKey;
    return jwt.setProtectedHeader({ alg: "RS256", kid: KID }).sign(key);
  }

  return {
    config: {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: `http://127.0.0.1:${server.port}/jwks`,
    },
    token,
    operatorToken: () => token({ roles: ["operator"], providerId: null }),
    providerToken: (providerId = "provider-a") =>
      token({ roles: ["provider"], providerId }),
    stop: async () => {
      await server.stop(true);
    },
  };
}
