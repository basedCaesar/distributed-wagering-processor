import {
  createRemoteJWKSet,
  customFetch,
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
 * Busca o JWKS e trata o emissor indisponível como transitório (D16.16):
 * conexão recusada, timeout ou resposta não-200 viram `TransientError`,
 * que o `jose` repassa sem embrulhar.
 */
async function fetchJwks(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    // Rejeição do `fetch` é sempre de rede (recusa, DNS, timeout do signal).
    throw new TransientError("JWKS do emissor inalcançável");
  }
  if (response.status !== 200) {
    throw new TransientError("JWKS do emissor respondeu fora do 200");
  }
  return response;
}

/**
 * Valida o JWT com o JWKS do emissor (D10.1): assinatura, emissor,
 * audiência, expiração e algoritmo (só RS256, D16.1). Papéis em
 * `realm_access.roles` e provedor em `provider_id`, como o Keycloak emite.
 */
export class JoseProviderIdentity implements ProviderIdentityPort {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: AuthConfig) {
    this.jwks = createRemoteJWKSet(new URL(config.jwksUrl), {
      timeoutDuration: config.jwksTimeoutMs,
      [customFetch]: fetchJwks,
    });
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
      // Emissor indisponível é transitório (D16.16); qualquer outro erro do
      // jose é token inválido.
      if (error instanceof TransientError) throw error;
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
