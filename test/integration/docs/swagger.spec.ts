import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startTestApi, type TestApi } from "../../support/api";

interface OpenApiResponse {
  content?: Record<string, { schema?: { $ref?: string } }>;
  headers?: Record<string, unknown>;
}

interface OpenApiOperation {
  responses: Record<string, OpenApiResponse>;
  security?: Record<string, unknown>[];
}

interface OpenApiSchema {
  properties?: Record<string, { $ref?: string; allOf?: { $ref?: string }[] }>;
  required?: string[];
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    securitySchemes?: Record<string, { type: string; scheme?: string }>;
    schemas: Record<string, OpenApiSchema>;
  };
}

const WALLET_OPERATIONS: [string, string][] = [
  ["/wallets", "post"],
  ["/wallets/{walletId}", "get"],
  ["/wallets/{walletId}/ledger", "get"],
  ["/wallets/{walletId}/reconciliation", "post"],
];

const TRANSACTION_QUERY_OPERATIONS: [string, string][] = [
  ["/wagering/transactions/{transactionId}", "get"],
  ["/providers/{providerId}/wagering/transactions/{externalTransactionId}", "get"],
];

const SUBMIT = "/wagering/transactions";

/** Status da submissão que respondem com o corpo da transação, não o de erro (D5, D16.4). */
const SUBMISSION_BODY_STATUSES = ["200", "202", "422", "500"];

/** Nome do schema referenciado (`#/components/schemas/X` → `X`). */
const schemaName = (ref: string | undefined) => ref?.split("/").at(-1);

let api: TestApi;
let doc: OpenApiDocument;

beforeAll(async () => {
  api = await startTestApi();
  const response = await fetch(`${api.baseUrl}/docs-json`);
  doc = (await response.json()) as OpenApiDocument;
});

afterAll(async () => {
  await api.close();
});

function statusesOf(path: string, method: string): string[] {
  const operation = doc.paths[path]?.[method];
  if (!operation) throw new Error(`${method.toUpperCase()} ${path} não está no Swagger`);
  return Object.keys(operation.responses).sort();
}

describe("S3 D13.2: Swagger em /docs", () => {
  it("D13.2 D10: esquema Bearer declarado", () => {
    const schemes = Object.values(doc.components.securitySchemes ?? {});
    expect(schemes).toContainEqual(
      expect.objectContaining({ type: "http", scheme: "bearer" }),
    );
  });

  it.each([
    ["/wallets", "post", ["201", "400", "401", "403", "409", "503"]],
    ["/wallets/{walletId}", "get", ["200", "400", "401", "404", "503"]],
    ["/wallets/{walletId}/ledger", "get", ["200", "400", "401", "404", "503"]],
    [
      "/wallets/{walletId}/reconciliation",
      "post",
      ["200", "400", "401", "403", "404", "503"],
    ],
  ])("D13.2 D5: %s %s documenta os status da D5 e exige Bearer", (path, method, statuses) => {
    expect(statusesOf(path, method)).toEqual([...statuses].sort());
    expect(doc.paths[path]?.[method]?.security?.length).toBeGreaterThan(0);
  });

  it("D13.2 D5: o corpo de erro é { error: { code, message, details? } }", () => {
    const envelope = doc.components.schemas.ErrorResponseDto;
    expect(envelope?.required).toContain("error");
    const detailRef =
      envelope?.properties?.error?.$ref ?? envelope?.properties?.error?.allOf?.[0]?.$ref;
    const detail = doc.components.schemas[schemaName(detailRef) ?? ""];
    expect(Object.keys(detail?.properties ?? {}).sort()).toEqual([
      "code",
      "details",
      "message",
    ]);
    expect([...(detail?.required ?? [])].sort()).toEqual(["code", "message"]);
  });

  it.each([
    [SUBMIT, "post", ["200", "202", "400", "401", "403", "404", "409", "422", "500", "503"]],
    [
      "/wagering/transactions/{transactionId}",
      "get",
      ["200", "400", "401", "404", "503"],
    ],
    [
      "/providers/{providerId}/wagering/transactions/{externalTransactionId}",
      "get",
      ["200", "400", "401", "404", "503"],
    ],
  ])("S4 D13.2 D5 D16.4: %s %s documenta os status da D5 e exige Bearer", (path, method, statuses) => {
    expect(statusesOf(path, method)).toEqual([...statuses].sort());
    expect(doc.paths[path]?.[method]?.security?.length).toBeGreaterThan(0);
  });

  it("S4 D13.2 R-09-12: a submissão documenta o header Idempotency-Key, obrigatório", () => {
    const operation = doc.paths[SUBMIT]?.post as OpenApiOperation & {
      parameters?: { name: string; in: string; required?: boolean }[];
    };
    expect(operation.parameters).toContainEqual(
      expect.objectContaining({ name: "Idempotency-Key", in: "header", required: true }),
    );
  });

  it("S4 D13.2 D5 D16.4: 200, 202, 422 e 500 da submissão usam o corpo da transação; o resto, o corpo de erro", () => {
    const responses = doc.paths[SUBMIT]?.post?.responses ?? {};
    for (const [status, response] of Object.entries(responses)) {
      const schema = schemaName(response.content?.["application/json"]?.schema?.$ref);
      expect({ status, schema }).toEqual({
        status,
        schema: SUBMISSION_BODY_STATUSES.includes(status)
          ? "SubmitTransactionResponseDto"
          : "ErrorResponseDto",
      });
    }
    expect(Object.keys(responses["503"]?.headers ?? {})).toEqual(["Retry-After"]);
  });

  it.each([...WALLET_OPERATIONS, ...TRANSACTION_QUERY_OPERATIONS])(
    "D13.2 D5 D16.3: %s %s documenta o corpo de erro em toda resposta de erro, e Retry-After no 503",
    (path, method) => {
      const responses = doc.paths[path]?.[method]?.responses ?? {};
      const errors = Object.entries(responses).filter(([status]) => status >= "400");
      expect(errors.length).toBeGreaterThan(0);
      for (const [status, response] of errors) {
        const ref = response.content?.["application/json"]?.schema?.$ref;
        expect({ status, schema: schemaName(ref) }).toEqual({
          status,
          schema: "ErrorResponseDto",
        });
      }
      expect(Object.keys(responses["503"]?.headers ?? {})).toEqual(["Retry-After"]);
    },
  );

  it.each([
    ["/health/live", "get", ["200"]],
    ["/health/ready", "get", ["200", "503"]],
  ])("D13.2 R-02-06: %s documentado, sem segurança", (path, method, statuses) => {
    expect(statusesOf(path, method)).toEqual(statuses);
    expect(doc.paths[path]?.[method]?.security ?? []).toEqual([]);
  });
});
