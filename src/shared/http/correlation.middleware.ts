import {
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  type NestMiddleware,
} from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { runWithContext } from "../logger/request-context";

export const CORRELATION_HEADER = "x-correlation-id";

/** D16.7: o formato da D6.4. */
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Rastreio de uma requisição (D9.5): vai para os eventos e os logs. */
export interface RequestMeta {
  correlationId: string;
  /** Id da requisição: o `causationId` dos eventos que ela causa. */
  requestId: string;
}

interface RequestWithMeta extends Request {
  requestMeta?: RequestMeta;
}

/**
 * Lê o `X-Correlation-Id` (ou gera um UUIDv7), devolve no header da
 * resposta e põe no contexto do logger (D9.5, D11.1, D16.7).
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: RequestWithMeta, res: Response, next: NextFunction): void {
    const header = req.headers[CORRELATION_HEADER];
    const correlationId =
      typeof header === "string" && VALID_CORRELATION_ID.test(header)
        ? header
        : Bun.randomUUIDv7();
    req.requestMeta = { correlationId, requestId: Bun.randomUUIDv7() };
    res.setHeader(CORRELATION_HEADER, correlationId);
    runWithContext({ correlationId }, next);
  }
}

export const CurrentRequestMeta = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RequestMeta => {
    const meta = ctx.switchToHttp().getRequest<RequestWithMeta>().requestMeta;
    if (!meta) throw new Error("CorrelationMiddleware não rodou nesta rota");
    return meta;
  },
);
