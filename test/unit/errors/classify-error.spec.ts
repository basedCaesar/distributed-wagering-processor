import { describe, expect, it } from "bun:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConnectionException } from "@mikro-orm/core";
import { InvalidMoneyError } from "../../../src/modules/wagering/domain/domain-error";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TransientError,
  UnauthenticatedError,
  ValidationError,
} from "../../../src/shared/errors/app-errors";
import { classifyError } from "../../../src/shared/errors/classify-error";

/** Erro como o `pg` (e o MikroORM, que copia as propriedades) entrega. */
function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error("erro do banco"), { code, constraint });
}

describe("S3 D5 D16.2: classifyError", () => {
  it("D5 D16.2: ValidationError → 400 VALIDATION_ERROR com os detalhes", () => {
    const classified = classifyError(
      new ValidationError("payload inválido", { issues: [{ path: "playerId" }] }),
    );

    expect(classified).toMatchObject({
      category: "validation",
      httpStatus: 400,
      code: "VALIDATION_ERROR",
      details: { issues: [{ path: "playerId" }] },
    });
  });

  it("D10.2 D16.2: sem token → 401 UNAUTHENTICATED; sem permissão → 403 FORBIDDEN", () => {
    expect(classifyError(new UnauthenticatedError())).toMatchObject({
      httpStatus: 401,
      code: "UNAUTHENTICATED",
    });
    expect(classifyError(new ForbiddenError())).toMatchObject({
      httpStatus: 403,
      code: "FORBIDDEN",
    });
  });

  it("D5 D16.2: NotFoundError → 404 NOT_FOUND", () => {
    expect(classifyError(new NotFoundError("wallet"))).toMatchObject({
      httpStatus: 404,
      code: "NOT_FOUND",
    });
  });

  it("D6.3 D16.2: ConflictError → 409 com o código e os detalhes dele", () => {
    const classified = classifyError(
      new ConflictError("WALLET_ALREADY_EXISTS", "já existe", { walletId: "w-1" }),
    );

    expect(classified).toMatchObject({
      httpStatus: 409,
      code: "WALLET_ALREADY_EXISTS",
      details: { walletId: "w-1" },
    });
  });

  it.each([
    ["55P03 (lock_timeout)", pgError("55P03")],
    ["57014 (statement_timeout)", pgError("57014")],
    ["40P01 (deadlock)", pgError("40P01")],
    ["08006 (conexão perdida)", pgError("08006")],
    ["57P01 (servidor desligando)", pgError("57P01")],
    ["ECONNREFUSED", pgError("ECONNREFUSED")],
    ["ConnectionException do MikroORM", new ConnectionException(new Error("x"))],
    ["TransientError", new TransientError("idp fora")],
  ])("D5 D16.2 D16.3: %s → transitório, 503 TEMPORARILY_UNAVAILABLE", (_, error) => {
    expect(classifyError(error)).toMatchObject({
      category: "transient",
      httpStatus: 503,
      code: "TEMPORARILY_UNAVAILABLE",
    });
  });

  it("D5: JSON mal formado (BadRequestException do Nest) → 400 VALIDATION_ERROR", () => {
    expect(classifyError(new BadRequestException("json"))).toMatchObject({
      httpStatus: 400,
      code: "VALIDATION_ERROR",
    });
  });

  it("D5: rota inexistente (NotFoundException do Nest) → 404 NOT_FOUND", () => {
    expect(classifyError(new NotFoundException())).toMatchObject({
      httpStatus: 404,
      code: "NOT_FOUND",
    });
  });

  it("D5: violação de constraint sem tradução é bug → 500, sem vazar a mensagem", () => {
    const classified = classifyError(pgError("23505", "wallets_pk"));

    expect(classified).toMatchObject({
      category: "internal",
      httpStatus: 500,
      code: "INTERNAL_ERROR",
    });
    expect(classified.message).not.toContain("banco");
  });

  it("D5: erro de domínio que escapou da borda é bug → 500", () => {
    expect(classifyError(new InvalidMoneyError("x"))).toMatchObject({
      category: "internal",
      httpStatus: 500,
    });
  });

  it("D5: qualquer outra coisa → 500", () => {
    expect(classifyError("string lançada")).toMatchObject({
      category: "internal",
      httpStatus: 500,
    });
  });
});
