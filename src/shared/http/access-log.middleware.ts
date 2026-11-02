import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../logger/logger";
import { getContext } from "../logger/request-context";

/** Rotas abertas e frequentes (probes, Swagger): sem linha de acesso (D22.9 b). */
const QUIET_PREFIXES = ["/health", "/docs"];

/**
 * Uma linha `info` por requisição HTTP, ao terminar (D22.9 b): método, rota
 * **em padrão** (`/wallets/:walletId`, nunca a URL crua), status e duração
 * em ms inteiros. Os ids vêm do contexto (D11.1), que o controller enriquece
 * (`enrichContext`); nunca o corpo, os headers nem valores.
 */
@Injectable()
export class AccessLogMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // O caminho completo: dentro do middleware montado pelo Nest, `req.path` é relativo.
    const path = req.originalUrl.split("?")[0] ?? "";
    if (QUIET_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}-`))) {
      next();
      return;
    }
    const startedAt = performance.now();
    // O mesmo objeto que o controller enriquece depois: lido no fim, já com os ids.
    const context = getContext();
    res.on("finish", () => {
      const route = (req.route as { path?: unknown } | undefined)?.path;
      logger.info(
        {
          ...context,
          method: req.method,
          route: typeof route === "string" ? route : "(sem rota)",
          status: res.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        },
        "requisição concluída",
      );
    });
    next();
  }
}
