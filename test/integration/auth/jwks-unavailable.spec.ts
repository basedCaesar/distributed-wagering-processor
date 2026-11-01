import { describe, expect, it } from "bun:test";
import type { JwksBehavior } from "../../support/auth";
import { type ErrorBody, startTestApi } from "../../support/api";

/**
 * Emissor indisponível é transitório (D16.16): o token pode ser válido, a
 * falha é do IdP. Cada caso sobe uma API nova, porque o `jose` guarda o
 * JWKS depois da primeira busca que dá certo.
 */
describe("S3 D16.16: JWKS do emissor indisponível", () => {
  it.each<[string, JwksBehavior]>([
    ["responde 503 (não-200)", "status503"],
    ["recusa a conexão", "refused"],
    ["não responde no prazo", "hang"],
  ])("D16.16 D16.3 D5: JWKS %s → 503 TEMPORARILY_UNAVAILABLE com Retry-After: 1", async (_, jwks) => {
    const api = await startTestApi({ jwks });
    try {
      const response = await api.request("GET", `/wallets/${Bun.randomUUIDv7()}`, {
        token: await api.issuer.operatorToken(),
      });
      const body = (await response.json()) as ErrorBody;

      expect({
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        code: body.error.code,
      }).toEqual({ status: 503, retryAfter: "1", code: "TEMPORARILY_UNAVAILABLE" });
    } finally {
      await api.close();
    }
  });
});
