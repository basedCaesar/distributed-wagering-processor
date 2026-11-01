import type { Logger } from "pino";
import { logger as processLogger } from "../logger/logger";
import { classifyError } from "./classify-error";

export interface BootstrapFailureDeps {
  logger: Pick<Logger, "fatal">;
  exit: (code: number) => void;
}

/**
 * Handler do `bootstrap().catch(...)` de todo entrypoint: a subida falhou
 * (config, banco, fila…). Classifica pelo `classifyError()`, loga categoria,
 * código e nome do erro (nunca a mensagem, que pode trazer dados, D11.1) e
 * sai com código 1, para o Compose reiniciar o processo.
 */
export function exitOnBootstrapFailure(
  processName: string,
  deps: BootstrapFailureDeps = { logger: processLogger, exit: (code) => process.exit(code) },
): (error: unknown) => void {
  return (error) => {
    const { category, code } = classifyError(error);
    const errorName = error instanceof Error ? error.name : typeof error;
    deps.logger.fatal({ process: processName, category, code, errorName }, "falha na subida do processo");
    deps.exit(1);
  };
}
