import type { Logger } from "pino";
import { classifyError } from "../../../shared/errors/classify-error";

/**
 * O `onDeliveryFailure` do hub (D28.7): uma entrega a um socket que falhou
 * é classificada e logada só com a categoria e o código. A mensagem do erro
 * e o evento ficam de fora (D11.1).
 */
export function logDeliveryFailure(logger: Logger): (error: unknown) => void {
  return (error) => {
    const { category, code } = classifyError(error);
    logger.warn({ category, code }, "entrega a um socket do realtime falhou");
  };
}
