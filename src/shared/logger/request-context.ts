import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Acrescenta ids ao contexto da operação em andamento (D22.9 a): o
 * `providerId` e o `walletId` depois da validação, o `transactionId` depois
 * do resultado. Muda o próprio objeto do contexto, então as linhas
 * seguintes da operação (inclusive a de acesso HTTP) os levam. Fora de um
 * contexto, não faz nada.
 */
export function enrichContext(fields: Partial<RequestContext>): void {
  const store = storage.getStore();
  if (!store) return;
  for (const [key, value] of Object.entries(fields) as [keyof RequestContext, string | undefined][]) {
    if (value !== undefined) store[key] = value;
  }
}
