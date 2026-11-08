import { describe, expect, it } from "bun:test";
import { countPointsByTag, perKey } from "../../../load/lib/k6-points";

/**
 * D26.6 R-13-C1: no C, as respostas originais (`idempotentReplay: false`) são
 * contadas key a key. O k6 grava cada amostra no `--out json` (uma linha JSON
 * por amostra), com as tags; o orquestrador soma por key.
 */

const point = (metric: string, value: number, tags: Record<string, string>) =>
  JSON.stringify({ type: "Point", metric, data: { time: "2026-11-08T00:00:00Z", value, tags } });

describe("D26.6: amostras do k6 por tag", () => {
  it("D26.6: soma os valores do metric pedido, agrupados pela tag", () => {
    const ndjson = [
      JSON.stringify({ type: "Metric", metric: "fresh", data: { type: "counter", contains: "default" } }),
      point("fresh", 1, { key: "0", scenario: "main" }),
      point("fresh", 1, { key: "1", scenario: "main" }),
      point("fresh", 1, { key: "1", scenario: "main" }),
      point("replays", 1, { key: "0", scenario: "main" }),
      point("http_req_duration", 12.5, { name: "submit" }),
      "",
    ].join("\n");
    expect(countPointsByTag(ndjson, "fresh", "key")).toEqual({ "0": 1, "1": 2 });
  });

  it("D26.6: amostra do metric sem a tag → erro (o script deixou de marcar a key)", () => {
    expect(() => countPointsByTag(point("fresh", 1, { scenario: "main" }), "fresh", "key")).toThrow();
  });

  it("D26.6: linha que não é JSON → erro com o número da linha", () => {
    expect(() => countPointsByTag(`${point("fresh", 1, { key: "0" })}\n{quebrado`, "fresh", "key")).toThrow(/linha 2/);
  });

  it("D26.6: perKey devolve uma posição por key, 0 para a key sem amostra", () => {
    expect(perKey({ "0": 1, "2": 3 }, 4)).toEqual([1, 0, 3, 0]);
  });

  it("D26.6: key fora de 0..keys-1 → erro (não pode sumir da conta)", () => {
    expect(() => perKey({ "0": 1, "9": 1 }, 4)).toThrow();
    expect(() => perKey({ x: 1 }, 4)).toThrow();
  });
});
