/**
 * Códigos de fechamento do WebSocket (D28.2). Os `4xxx` são do protocolo;
 * os outros, da RFC 6455. Dizem ao cliente se reconectar resolve.
 */
export const CloseCode = {
  /** Protocolo violado antes do `auth`. Reconectar igual não resolve. */
  ProtocolViolation: 4400,
  /** Token ausente, inválido, sem papel ou vencido. Precisa de outro token. */
  Unauthenticated: 4401,
  /** O `auth` não chegou no prazo. */
  AuthTimeout: 4408,
  /** O JWKS do emissor está indisponível (D16.16). Reconectar resolve. */
  AuthUnavailable: 4503,
  /** O processo está parando. Reconectar resolve (outra instância). */
  GoingAway: 1001,
  /** Frame acima do limite. */
  MessageTooBig: 1009,
  /** Erro inesperado do servidor (bug): logado com `classifyError()`. */
  InternalError: 1011,
  /** Cliente lento: o buffer de envio passou do limite. Reconectar resolve. */
  TryAgainLater: 1013,
} as const;

export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];
