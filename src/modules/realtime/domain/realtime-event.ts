export type Role = "provider" | "operator";

/** Quem está do outro lado do socket, segundo o token (D10.1, D28.2). */
export interface Viewer {
  readonly roles: ReadonlySet<Role>;
  /** Presente quando `roles` tem `provider` (D16.1). */
  readonly providerId?: string;
}

/**
 * Quem pode ver o evento (D28.3, D10.2): os da wallet vão a quem segue;
 * os de transação, ao operador e ao provedor dela (`null` na `OPENING`:
 * só o operador).
 */
export type Audience = { readonly kind: "wallet" } | { readonly kind: "transaction"; readonly providerId: string | null };

/**
 * Um evento do núcleo já projetado pela lista fechada (D28.4): `data` só
 * tem os campos que o cliente pode ver. Valores ficam como chegaram
 * (string + moeda, D2): o realtime não faz conta.
 */
export interface RealtimeEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly walletId: string;
  readonly walletVersion: number | null;
  readonly data: Readonly<Record<string, unknown>>;
  readonly audience: Audience;
}

/** O que vai pelo socket: o evento sem a audiência (D28.4). */
export interface ClientEventMessage {
  readonly type: "event";
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly walletId: string;
  readonly walletVersion: number | null;
  readonly data: Readonly<Record<string, unknown>>;
}

/** As permissões das consultas HTTP, aplicadas ao evento (D28.3, D10.2, D16.10). */
export function canSee(viewer: Viewer, event: RealtimeEvent): boolean {
  if (event.audience.kind === "wallet") return true;
  if (viewer.roles.has("operator")) return true;
  const { providerId } = event.audience;
  return providerId !== null && viewer.roles.has("provider") && viewer.providerId === providerId;
}

export function toClientMessage(event: RealtimeEvent): ClientEventMessage {
  return {
    type: "event",
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    walletId: event.walletId,
    walletVersion: event.walletVersion,
    data: event.data,
  };
}
