import type { EntitySchema } from "@mikro-orm/core";
import { OutboxMessageSchema } from "./outbox-message.schema";
import { ReconciliationRunSchema } from "./reconciliation-run.schema";
import { WagerTransactionSchema } from "./wager-transaction.schema";
import { WalletLedgerEntrySchema } from "./wallet-ledger-entry.schema";
import { WalletSchema } from "./wallet.schema";

/** Entidades do contexto `wagering` registradas no ORM (D7.1). */
export const WAGERING_ENTITIES: EntitySchema[] = [
  WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  OutboxMessageSchema,
  ReconciliationRunSchema,
];
