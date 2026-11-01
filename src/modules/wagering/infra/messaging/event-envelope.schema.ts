import { z } from "zod";
import { ValidationError } from "../../../../shared/errors/app-errors";
import { parseOrThrow } from "../../../../shared/http/zod";
import type { AuditableEvent } from "../../application/audit-integration-event.use-case";

/**
 * `data` do envelope: livre (cada evento tem o seu, D9.4), mas `walletId` e
 * `walletVersion`, quando existem, têm formato fixo, porque entram na
 * checagem de ordem (D20.1). `walletVersion` só com `walletId`.
 */
const dataSchema = z
  .looseObject({
    walletId: z.uuid("data.walletId: UUID").optional(),
    walletVersion: z.number().int("data.walletVersion: inteiro").min(1, "data.walletVersion ≥ 1").optional(),
  })
  .refine((data) => data.walletVersion === undefined || data.walletId !== undefined, {
    message: "data.walletVersion sem data.walletId",
  });

/** Envelope do §11 (R-11-09, D20.2). Aceita qualquer `eventType` com o formato de um nome de classe. */
const envelopeSchema = z.object({
  eventId: z.uuid("eventId: UUID"),
  eventType: z.string().regex(/^[A-Z][A-Za-z0-9]{0,127}$/, "eventType: nome do evento"),
  aggregateId: z.uuid("aggregateId: UUID"),
  correlationId: z.string().min(1).max(255),
  causationId: z.string().min(1).max(255).optional(),
  occurredAt: z.iso.datetime("occurredAt: ISO 8601"),
  version: z.number().int().min(1, "version ≥ 1"),
  data: dataSchema,
});

export interface ParsedEventEnvelope extends AuditableEvent {
  correlationId: string;
}

/**
 * Corpo da mensagem (o envelope publicado pelo SNS com `RawMessageDelivery`)
 * → evento auditável. JSON quebrado ou fora do schema → `ValidationError`
 * (permanente, DLQ do auditor, D20.2). O envelope **cru** vai junto: é ele
 * que entra no hash da inbox (D20.1). Nenhum valor recebido vai para o erro.
 */
export function parseEventEnvelope(body: string): ParsedEventEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ValidationError("evento não é JSON");
  }
  const envelope = parseOrThrow(envelopeSchema, json, "evento");
  const { walletId, walletVersion } = envelope.data;
  return {
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    aggregateId: envelope.aggregateId,
    correlationId: envelope.correlationId,
    occurredAt: new Date(envelope.occurredAt),
    ...(walletId !== undefined && { walletId }),
    ...(walletVersion !== undefined && { walletVersion }),
    envelope: json,
  };
}
