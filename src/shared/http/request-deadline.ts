import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  type NestMiddleware,
} from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { Observable } from "rxjs";
import { APP_CONFIG, type AppConfig } from "../config/config.module";
import { TransientError } from "../errors/app-errors";
import { classifyError } from "../errors/classify-error";
import { logger } from "../logger/logger";

/** Prazo da requisição esgotado (D5, D21.3): transitório, `503` + `Retry-After`. */
export class RequestDeadlineExceededError extends TransientError {
  constructor() {
    super("Prazo da requisição esgotado");
  }
}

interface RequestWithStart extends Request {
  receivedAt?: number;
  requestMeta?: { correlationId: string };
}

/** Marca a chegada da requisição: o prazo conta desde aqui, incluindo o guard (D21.3). */
@Injectable()
export class RequestDeadlineMiddleware implements NestMiddleware {
  use(req: RequestWithStart, _res: Response, next: NextFunction): void {
    req.receivedAt = performance.now();
    next();
  }
}

/** Só ids e a rota, nunca o corpo nem valores (D11.1). */
function lateFields(req: RequestWithStart): Record<string, unknown> {
  const key = req.headers["idempotency-key"];
  return {
    method: req.method,
    route: req.route?.path ?? req.path,
    ...(req.requestMeta && { correlationId: req.requestMeta.correlationId }),
    ...(typeof key === "string" && { idempotencyKey: key }),
  };
}

/**
 * Prazo de cada requisição (D5: 10 s; `HTTP_REQUEST_TIMEOUT_MS`, D21.3).
 * Estourado → `RequestDeadlineExceededError`, que o filtro transforma em
 * `503 TEMPORARILY_UNAVAILABLE` com `Retry-After`. O trabalho em andamento
 * **não** é cancelado: se ele commitar depois, o reenvio com a mesma key
 * cai no replay (D3.4).
 *
 * O desfecho tardio não some: o handler continua inscrito e, quando
 * termina, loga "requisição commitou depois do prazo" ou "requisição falhou
 * depois do prazo" (o erro passa por `classifyError()`), com
 * `correlationId` e `idempotencyKey`, sem o corpo da resposta (D11.1).
 * Assim dá para saber se uma requisição que levou `503` commitou.
 */
@Injectable()
export class RequestDeadlineInterceptor implements NestInterceptor {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestWithStart>();
    const elapsed = req.receivedAt === undefined ? 0 : performance.now() - req.receivedAt;
    const remaining = Math.max(0, this.config.http.requestTimeoutMs - elapsed);

    return new Observable<unknown>((subscriber) => {
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        subscriber.error(new RequestDeadlineExceededError());
      }, remaining);
      const inner = next.handle().subscribe({
        next: (value) => {
          if (late) {
            // Um handler HTTP emite uma vez: a resposta tardia, que é descartada.
            logger.warn({ ...lateFields(req), lateOutcome: "committed" }, "requisição commitou depois do prazo");
            return;
          }
          subscriber.next(value);
        },
        error: (error: unknown) => {
          clearTimeout(timer);
          if (late) {
            const { category, code } = classifyError(error);
            logger.warn(
              { ...lateFields(req), lateOutcome: "failed", category, code },
              "requisição falhou depois do prazo",
            );
            return;
          }
          subscriber.error(error);
        },
        complete: () => {
          clearTimeout(timer);
          if (!late) subscriber.complete();
        },
      });
      // Depois do 503, o handler continua inscrito até terminar (o desfecho é logado).
      return () => {
        clearTimeout(timer);
        if (!late) inner.unsubscribe();
      };
    });
  }
}
