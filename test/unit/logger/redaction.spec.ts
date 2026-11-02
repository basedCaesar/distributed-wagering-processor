import { describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import { createLogger } from "../../../src/shared/logger/logger";

/** R-12-02 D11.1 D22.9 (c, e): a configuração do pino, sem banco nem rede. */

function capture() {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n")) if (line.trim() !== "") lines.push(JSON.parse(line));
      done();
    },
  });
  return { logger: createLogger(sink), lines };
}

const SECRETS = ["6087.41", "player-secret-1", "Bearer eyJ.secret.token", "9105.38", "corpo-secreto"];

describe("R-12-02 D22.9 (c): redact por nome de campo", () => {
  it("R-12-02 D22.9: amount, money, balance*, initialBalance, playerId, authorization, payload e body no 1º nível → [REDACTED]", () => {
    const { logger, lines } = capture();

    logger.info(
      {
        amount: "6087.41",
        money: { amount: "6087.41", currency: "BRL" },
        balance: "9105.38",
        balanceAfter: "9105.38",
        balanceBefore: "9105.38",
        initialBalance: { amount: "9105.38" },
        playerId: "player-secret-1",
        authorization: "Bearer eyJ.secret.token",
        payload: { anything: "corpo-secreto" },
        body: "corpo-secreto",
      },
      "primeiro nível",
    );

    expect(JSON.stringify(lines)).not.toMatch(new RegExp(SECRETS.map((s) => s.replaceAll(".", "\\.")).join("|")));
    expect(lines[0]).toMatchObject({ amount: "[REDACTED]", playerId: "[REDACTED]", authorization: "[REDACTED]" });
  });

  it("R-12-02 D22.9: os mesmos campos no 2º nível → [REDACTED]", () => {
    const { logger, lines } = capture();

    logger.info(
      {
        req: { headers: { authorization: "Bearer eyJ.secret.token" } },
        headers: { authorization: "Bearer eyJ.secret.token" },
        command: { playerId: "player-secret-1", money: { amount: "6087.41" }, amount: "6087.41" },
        wallet: { balance: "9105.38", initialBalance: "9105.38", balanceAfter: "9105.38", balanceBefore: "9105.38" },
        message: { body: "corpo-secreto", payload: "corpo-secreto" },
      },
      "segundo nível",
    );

    const dump = JSON.stringify(lines);
    for (const secret of SECRETS) expect(dump).not.toContain(secret);
  });

  it("D22.9: ids e campos de contexto não são censurados", () => {
    const { logger, lines } = capture();

    logger.info({ walletId: "w-1", transactionId: "t-1", providerId: "provider-a", status: "PROCESSED" }, "ids");

    expect(lines[0]).toMatchObject({ walletId: "w-1", transactionId: "t-1", providerId: "provider-a", status: "PROCESSED" });
  });
});

describe("R-12-02 D22.9 (e): serializer de erro", () => {
  /** Como o `pg` entrega uma violação: a linha inteira no `detail`, a query no `where`. */
  const pgLike = () =>
    Object.assign(new Error("insert into wallets values ('player-secret-1', -6087.41) - violates check"), {
      code: "23514",
      constraint: "wallets_balance_non_negative_ck",
      table: "wallets",
      schema: "public",
      detail: "Failing row contains (player-secret-1, -6087.41).",
      where: "SQL statement \"insert ... 9105.38\"",
      parameters: ["player-secret-1", "-6087.41"],
      query: "insert into wallets ... 'player-secret-1'",
    });

  it("R-12-02 D22.9: err e error levam só type, code, constraint e table", () => {
    const { logger, lines } = capture();

    logger.error({ err: pgLike() }, "pelo err");
    logger.error({ error: pgLike() }, "pelo error");

    const dump = JSON.stringify(lines);
    for (const secret of SECRETS) expect(dump).not.toContain(secret);
    const expected = { type: "Error", code: "23514", constraint: "wallets_balance_non_negative_ck", table: "wallets" };
    expect(lines[0]?.err).toEqual(expected);
    expect(lines[1]?.error).toEqual(expected);
  });

  it("R-12-02 D22.9: um Error passado como 1º argumento também passa pelo serializer", () => {
    const { logger, lines } = capture();

    logger.error(pgLike());

    const dump = JSON.stringify(lines);
    for (const secret of SECRETS) expect(dump).not.toContain(secret);
  });

  it("D22.9: code, constraint e table fora do formato de identificador são descartados", () => {
    const { logger, lines } = capture();

    logger.error(
      { err: Object.assign(new Error("x"), { code: "a b; player-secret-1", constraint: "x' OR 1=1", table: 42 }) },
      "formato inválido",
    );

    expect(lines[0]?.err).toEqual({ type: "Error" });
  });
});
