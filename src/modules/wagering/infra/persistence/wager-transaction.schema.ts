import { EntitySchema } from "@mikro-orm/core";
import { DecimalAmountType } from "../../../../shared/orm/decimal-amount.type";
import { fkId } from "../../../../shared/orm/fk-id";
import { WalletSchema } from "./wallet.schema";

/**
 * Linha de `wager_transactions`. Os campos do provedor são nulos na
 * `OPENING` (D6.1, D14.5). As colunas de controle do worker ficam fora da
 * entidade (D4.5). Só `next_attempt_at` é mapeada, para a pendente nascer
 * já vencida (D17.4); `attempts` e `locked_until` o worker (S5) lê e
 * escreve por SQL próprio, e o banco as preenche com o default.
 */
export interface WagerTransactionRecord {
  id: string;
  providerId: string | null;
  externalTransactionId: string | null;
  idempotencyKey: string | null;
  payloadHash: string | null;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  failureDetail: string | null;
  /** Saldo observado, na moeda da wallet (D3.5). */
  balanceAfter: string | null;
  balanceAfterCurrency: string | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Rastreio da submissão (D9.5). Não está na entidade: o repositório o
   * recebe ao salvar. Gravado no INSERT e imutável depois (trigger).
   */
  correlationId: string | null;
  /** Controle do worker (D4.3), fora da entidade; o repositório preenche (D17.4). */
  nextAttemptAt?: Date | null;
}

const nullableText = (fieldName: string) =>
  ({ type: "string", fieldName, nullable: true }) as const;

export const WagerTransactionSchema: EntitySchema<WagerTransactionRecord> =
  new EntitySchema<WagerTransactionRecord>({
    name: "WagerTransactionRecord",
    tableName: "wager_transactions",
    properties: {
      id: { type: "uuid", primary: true },
      providerId: nullableText("provider_id"),
      externalTransactionId: nullableText("external_transaction_id"),
      idempotencyKey: nullableText("idempotency_key"),
      payloadHash: nullableText("payload_hash"),
      walletId: fkId(() => WalletSchema, "wallet_id"),
      playerId: { type: "string", fieldName: "player_id" },
      roundId: nullableText("round_id"),
      gameId: nullableText("game_id"),
      kind: { type: "string" },
      amount: { type: DecimalAmountType },
      currency: { type: "string", columnType: "char(3)" },
      referenceExternalTransactionId: nullableText(
        "reference_external_transaction_id",
      ),
      referenceTransactionId: fkId(
        () => WagerTransactionSchema,
        "reference_transaction_id",
        { nullable: true },
      ),
      status: { type: "string" },
      failureCode: nullableText("failure_code"),
      failureDetail: nullableText("failure_detail"),
      balanceAfter: {
        type: DecimalAmountType,
        fieldName: "balance_after",
        nullable: true,
      },
      balanceAfterCurrency: nullableText("balance_after_currency"),
      processedAt: {
        type: "datetime",
        fieldName: "processed_at",
        columnType: "timestamptz",
        nullable: true,
      },
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
      correlationId: nullableText("correlation_id"),
      nextAttemptAt: {
        type: "datetime",
        fieldName: "next_attempt_at",
        columnType: "timestamptz",
        nullable: true,
      },
    },
  });
