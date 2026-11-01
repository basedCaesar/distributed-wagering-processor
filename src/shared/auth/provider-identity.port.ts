export type Role = "provider" | "operator";

/** Quem chama, segundo o token (D10.1). */
export interface Identity {
  subject: string;
  roles: ReadonlySet<Role>;
  /** Presente sempre que `roles` tem `provider` (D16.1). */
  providerId?: string;
}

/**
 * Ponto de extensão da autenticação (R-02-05): valida o token e devolve a
 * identidade, ou lança `UnauthenticatedError`.
 */
export interface ProviderIdentityPort {
  authenticate(bearerToken: string): Promise<Identity>;
}

export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");
