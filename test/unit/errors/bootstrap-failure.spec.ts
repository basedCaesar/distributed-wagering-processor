import { describe, expect, it } from "bun:test";
import { exitOnBootstrapFailure } from "../../../src/shared/errors/bootstrap-failure";

function fakes() {
  const logged: { fields: Record<string, unknown>; msg: string }[] = [];
  const exits: number[] = [];
  return {
    logged,
    exits,
    deps: {
      logger: {
        fatal: (fields: Record<string, unknown>, msg: string) => {
          logged.push({ fields, msg });
        },
      } as never,
      exit: (code: number) => {
        exits.push(code);
      },
    },
  };
}

describe("CLAUDE.md: falha na subida de um entrypoint", () => {
  it("classifica pelo classifyError, loga sem a mensagem do erro e sai com código 1", () => {
    const { logged, exits, deps } = fakes();

    exitOnBootstrapFailure("consumer", deps)(new Error("senha=segredo no texto"));

    expect(exits).toEqual([1]);
    expect(logged).toEqual([
      {
        fields: { process: "consumer", category: "internal", code: "INTERNAL_ERROR", errorName: "Error" },
        msg: "falha na subida do processo",
      },
    ]);
    expect(JSON.stringify(logged)).not.toContain("segredo");
  });

  it("D5: banco ou fila fora na subida → transitório", () => {
    const { logged, exits, deps } = fakes();

    exitOnBootstrapFailure("api", deps)(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }));

    expect(exits).toEqual([1]);
    expect(logged[0]?.fields).toMatchObject({ process: "api", category: "transient", code: "TEMPORARILY_UNAVAILABLE" });
  });
});
