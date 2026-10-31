import { EntitySchema } from "@mikro-orm/core";
import { DecimalAmountType } from "../../../../shared/orm/decimal-amount.type";
import { fkId } from "../../../../shared/orm/fk-id";
import { WagerTransactionSchema } from "./wager-transaction.schema";
import { WalletSchema } from "./wallet.schema";

/** Linha de `wallet_ledger_entries`: só INSERT e SELECT (R-05-05). */
export interface WalletLedgerEntryRecord {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
  createdAt: Date;
}

export const WalletLedgerEntrySchema =
  new EntitySchema<WalletLedgerEntryRecord>({
    name: "WalletLedgerEntryRecord",
    tableName: "wallet_ledger_entries",
    // Sem `readonly: true`: no MikroORM ele também bloqueia o INSERT. A
    // imutabilidade fica no banco (privilégio + trigger, D7.3).
    properties: {
      id: { type: "uuid", primary: true },
      walletId: fkId(() => WalletSchema, "wallet_id"),
      transactionId: fkId(() => WagerTransactionSchema, "transaction_id"),
      direction: { type: "string" },
      amount: { type: DecimalAmountType },
      currency: { type: "string", columnType: "char(3)" },
      balanceBefore: { type: DecimalAmountType, fieldName: "balance_before" },
      balanceAfter: { type: DecimalAmountType, fieldName: "balance_after" },
      walletVersion: { type: "integer", fieldName: "wallet_version" },
      createdAt: {
        type: "datetime",
        fieldName: "created_at",
        columnType: "timestamptz",
      },
    },
  });
