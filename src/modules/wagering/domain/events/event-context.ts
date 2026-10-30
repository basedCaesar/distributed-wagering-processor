/** Metadados de um evento, vindos de quem o cria (D6.6, D9.5). */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}
