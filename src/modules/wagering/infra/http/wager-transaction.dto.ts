import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { MoneyDto } from "./wallet.dto";

/**
 * Classes só para o Swagger (D13.2). A validação de entrada é do zod
 * (`wager-transaction.schemas.ts`); a saída é montada em
 * `wager-transaction.presenter.ts`.
 */
const IDENTIFIER = "1 a 128 caracteres [A-Za-z0-9._:-] (D17.1)";

const KINDS = ["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"];
const STATUSES = ["PROCESSED", "REJECTED", "PENDING_REFERENCE", "FAILED"];
const SCOPE_FIELDS = ["PLAYER", "WALLET", "CURRENCY", "ROUND"];

export class SubmitTransactionRequestDto {
  @ApiProperty({ example: "provider-a", description: `Igual ao provider_id do token (D10.2). ${IDENTIFIER}` })
  providerId!: string;

  @ApiProperty({ example: "transaction-123", description: IDENTIFIER })
  externalTransactionId!: string;

  @ApiProperty({ example: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", description: "D6.4" })
  playerId!: string;

  @ApiProperty({ example: "0192f291-27dd-7d3f-8071-5f8685deef37", description: "UUID" })
  walletId!: string;

  @ApiProperty({ example: "round-987", description: IDENTIFIER })
  roundId!: string;

  @ApiProperty({ example: "fortune-chimp", description: IDENTIFIER })
  gameId!: string;

  @ApiProperty({ enum: KINDS, description: "OPENING é interno (R-06-38)" })
  kind!: string;

  @ApiProperty({
    type: MoneyDto,
    description: "Maior que zero; LOSS aceita 0 (D2.3). Moeda igual à da wallet, senão REJECTED.",
  })
  money!: MoneyDto;

  @ApiPropertyOptional({
    example: "transaction-122",
    description:
      "Id externo da referência, do mesmo provedor. Obrigatória em REFUND/ROLLBACK, opcional em WIN/LOSS, proibida na BET (D1.5).",
  })
  referenceExternalTransactionId?: string;
}

export class SubmitTransactionResponseDto {
  @ApiProperty({ example: "0192f298-345e-7e38-af88-e43f851a819d" })
  transactionId!: string;

  @ApiProperty({ enum: STATUSES })
  status!: string;

  @ApiPropertyOptional({ example: "INSUFFICIENT_FUNDS", description: "Só em REJECTED e FAILED (D5)" })
  failureCode?: string;

  @ApiPropertyOptional({ enum: SCOPE_FIELDS, description: "Só com REFERENCE_SCOPE_MISMATCH (D14.3)" })
  failureDetail?: string;

  @ApiPropertyOptional({
    type: MoneyDto,
    description: "Saldo observado na decisão (D3.5); ausente enquanto pendente",
  })
  balance?: MoneyDto;

  @ApiProperty({ description: "true quando a key já tinha sido processada (D3.4)" })
  idempotentReplay!: boolean;
}

export class TransactionResponseDto {
  @ApiProperty()
  transactionId!: string;

  @ApiProperty({ type: String, nullable: true, description: "null na OPENING (D6.1)" })
  providerId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "null na OPENING (D6.1)" })
  externalTransactionId!: string | null;

  @ApiProperty()
  walletId!: string;

  @ApiProperty()
  playerId!: string;

  @ApiProperty({ type: String, nullable: true, description: "null na OPENING (D6.1)" })
  roundId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "null na OPENING (D6.1)" })
  gameId!: string | null;

  @ApiProperty({ enum: ["OPENING", ...KINDS] })
  kind!: string;

  @ApiProperty({ type: MoneyDto })
  money!: MoneyDto;

  @ApiPropertyOptional()
  referenceExternalTransactionId?: string;

  @ApiPropertyOptional({ description: "Id interno da referência, só no PROCESSED (D14.6)" })
  referenceTransactionId?: string;

  @ApiProperty({ enum: STATUSES })
  status!: string;

  @ApiPropertyOptional()
  failureCode?: string;

  @ApiPropertyOptional({ enum: SCOPE_FIELDS })
  failureDetail?: string;

  @ApiPropertyOptional({ type: MoneyDto, description: "Saldo observado (D3.5)" })
  balance?: MoneyDto;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;

  @ApiPropertyOptional({ format: "date-time", description: "Só no PROCESSED" })
  processedAt?: string;
}
