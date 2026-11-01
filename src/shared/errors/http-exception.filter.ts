import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  Inject,
} from "@nestjs/common";
import type { Response } from "express";
import type { Logger } from "pino";
import { LOGGER } from "../logger/logger.module";
import { classifyError } from "./classify-error";

/** Segundos sugeridos ao provedor num `503` (D16.3). */
export const RETRY_AFTER_SECONDS = 1;

/**
 * Todo erro que chega à borda HTTP passa por `classifyError()` e vira o
 * corpo da D5: `{ error: { code, message, details? } }`.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const classified = classifyError(error);
    const response = host.switchToHttp().getResponse<Response>();

    if (classified.category === "internal" || classified.category === "transient") {
      // Só identificação do erro: nunca o payload nem o `detail` do banco,
      // que pode trazer valores (D11.1).
      const { name, code, constraint } = (error ?? {}) as {
        name?: string;
        code?: string;
        constraint?: string;
      };
      this.logger[classified.category === "internal" ? "error" : "warn"](
        { errorName: name, code, constraint, category: classified.category },
        "requisição falhou",
      );
    }
    if (classified.category === "transient") {
      response.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
    }
    response.status(classified.httpStatus).json({
      error: {
        code: classified.code,
        message: classified.message,
        ...(classified.details !== undefined && { details: classified.details }),
      },
    });
  }
}
