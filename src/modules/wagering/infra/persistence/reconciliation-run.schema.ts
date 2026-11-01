import { EntitySchema } from "@mikro-orm/core";
import { DecimalAmountType } from "../../../../shared/orm/decimal-amount.type";

/** Linha de `reconciliation_runs`: append-only (D6.9). */
export interface ReconciliationRunRecord {
  id: string;
  walletId: string;
  currency: string;
  storedBalance: string;
  calculatedBalance: string;
  difference: string;
  checkedEntries: number;
  consistent: boolean;
  issues: unknown;
  executedAt: Date;
}

export const ReconciliationRunSchema = new EntitySchema<ReconciliationRunRecord>(
  {
    name: "ReconciliationRunRecord",
    tableName: "reconciliation_runs",
    properties: {
      id: { type: "uuid", primary: true },
      walletId: { type: "uuid", fieldName: "wallet_id" },
      currency: { type: "string", columnType: "char(3)" },
      storedBalance: { type: DecimalAmountType, fieldName: "stored_balance" },
      calculatedBalance: {
        type: DecimalAmountType,
        fieldName: "calculated_balance",
      },
      difference: { type: DecimalAmountType },
      checkedEntries: { type: "integer", fieldName: "checked_entries" },
      consistent: { type: "boolean" },
      issues: { type: "json", columnType: "jsonb" },
      executedAt: {
        type: "datetime",
        fieldName: "executed_at",
        columnType: "timestamptz",
      },
    },
  },
);
