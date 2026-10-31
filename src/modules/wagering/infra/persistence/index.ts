import type { EntitySchema } from "@mikro-orm/core";
import { WagerTransactionSchema } from "./wager-transaction.schema";
import { WalletLedgerEntrySchema } from "./wallet-ledger-entry.schema";
import { WalletSchema } from "./wallet.schema";

/** Entidades do contexto `wagering` registradas no ORM (D7.1). */
export const WAGERING_ENTITIES: EntitySchema[] = [
  WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
];
