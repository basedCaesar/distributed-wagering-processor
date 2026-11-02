import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  type NestMiddleware,
} from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { type Observable, throwError, timeout } from "rxjs";
import { APP_CONFIG, type AppConfig } from "../config/config.module";
import { TransientError } from "../errors/app-errors";

/** Prazo da requisição esgotado (D5, D21.3): transitório, `503` + `Retry-After`. */
export class RequestDeadlineExceededError extends TransientError {
  constructor() {
    super("Prazo da requisição esgotado");
  }
}

interface RequestWithStart extends Request {
  receivedAt?: number;
}

/** Marca a chegada da requisição: o prazo conta desde aqui, incluindo o guard (D21.3). */
@Injectable()
export class RequestDeadlineMiddleware implements NestMiddleware {
  use(req: RequestWithStart, _res: Response, next: NextFunction): void {
    req.receivedAt = performance.now();
    next();
  }
}

/**
 * Prazo de cada requisição (D5: 10 s; `HTTP_REQUEST_TIMEOUT_MS`, D21.3).
 * Estourado → `RequestDeadlineExceededError`, que o filtro transforma em
 * `503 TEMPORARILY_UNAVAILABLE` com `Retry-After`. O trabalho em andamento
 * **não** é cancelado: se ele commitar depois, o reenvio com a mesma key
 * cai no replay (D3.4). A resposta tardia do handler é descartada.
 */
@Injectable()
export class RequestDeadlineInterceptor implements NestInterceptor {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestWithStart>();
    const elapsed = req.receivedAt === undefined ? 0 : performance.now() - req.receivedAt;
    const remaining = Math.max(0, this.config.http.requestTimeoutMs - elapsed);
    return next.handle().pipe(
      timeout({ first: remaining, with: () => throwError(() => new RequestDeadlineExceededError()) }),
    );
  }
}
