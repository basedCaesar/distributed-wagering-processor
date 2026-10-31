import { EntitySchema } from "@mikro-orm/core";
import { DecimalAmountType } from "../../../../shared/orm/decimal-amount.type";

/** Linha de `wallets`. Objeto plano: o domínio não conhece o ORM (D7.1). */
export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `version` é uma coluna comum, sem `version: true`: quem a incrementa é o
 * domínio (`Wallet.debit`/`credit`), uma vez por mudança de saldo (D7.2).
 * A segunda camada é do banco (D15.7).
 */
export const WalletSchema = new EntitySchema<WalletRecord>({
  name: "WalletRecord",
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "string", fieldName: "player_id" },
    currency: { type: "string", columnType: "char(3)" },
    balance: { type: DecimalAmountType },
    version: { type: "integer" },
    createdAt: {
      type: "datetime",
      fieldName: "created_at",
      columnType: "timestamptz",
    },
    updatedAt: {
      type: "datetime",
      fieldName: "updated_at",
      columnType: "timestamptz",
    },
  },
});
