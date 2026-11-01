import {
  createRemoteJWKSet,
  errors,
  type JWTPayload,
  jwtVerify,
} from "jose";
import { TransientError, UnauthenticatedError } from "../errors/app-errors";
import type { AuthConfig } from "./auth.config";
import type {
  Identity,
  ProviderIdentityPort,
  Role,
} from "./provider-identity.port";

const KNOWN_ROLES: readonly Role[] = ["provider", "operator"];

/**
 * Valida o JWT com o JWKS do emissor (D10.1): assinatura, emissor,
 * audiência, expiração e algoritmo (só RS256, D16.1). Papéis em
 * `realm_access.roles` e provedor em `provider_id`, como o Keycloak emite.
 */
export class JoseProviderIdentity implements ProviderIdentityPort {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: AuthConfig) {
    this.jwks = createRemoteJWKSet(new URL(config.jwksUrl));
  }

  async authenticate(bearerToken: string): Promise<Identity> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(bearerToken, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ["RS256"],
      }));
    } catch (error) {
      // JWKS fora do ar é transitório; qualquer outro erro do jose é token inválido.
      if (error instanceof errors.JWKSTimeout) {
        throw new TransientError("JWKS do emissor não respondeu");
      }
      if (error instanceof errors.JOSEError) throw new UnauthenticatedError();
      throw error;
    }
    return identityFrom(payload);
  }
}

function identityFrom(payload: JWTPayload): Identity {
  const claimed = (payload.realm_access as { roles?: unknown } | undefined)
    ?.roles;
  const roles = new Set<Role>(
    Array.isArray(claimed)
      ? KNOWN_ROLES.filter((role) => claimed.includes(role))
      : [],
  );
  if (roles.size === 0) throw new UnauthenticatedError("Token sem papel conhecido");

  const providerId = payload.provider_id;
  const hasProviderId = typeof providerId === "string" && providerId !== "";
  if (roles.has("provider") && !hasProviderId) {
    throw new UnauthenticatedError("Token de provedor sem provider_id");
  }
  return {
    subject: payload.sub ?? "",
    roles,
    ...(hasProviderId && { providerId }),
  };
}
