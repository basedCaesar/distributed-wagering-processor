import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * Classes só para o Swagger (D13.2). A validação de entrada é do zod
 * (`wallet.schemas.ts`); a saída é montada em `wallet.presenter.ts`.
 */
export class MoneyDto {
  @ApiProperty({
    example: "1000.00",
    description: "Entrada: 0 a 2 casas, sem sinal, até 12 dígitos inteiros. Saída: sempre 2 casas.",
  })
  amount!: string;

  @ApiProperty({ example: "BRL", description: "Moeda da lista configurada (BRL, USD)" })
  currency!: string;
}

export class CreateWalletRequestDto {
  @ApiProperty({
    example: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    description: "1 a 128 caracteres [A-Za-z0-9._:-] (D6.4)",
  })
  playerId!: string;

  @ApiProperty({
    type: MoneyDto,
    description: "Obrigatório; define a moeda. Maior que zero gera a OPENING (D2.3, D6.7).",
  })
  initialBalance!: MoneyDto;
}

export class WalletResponseDto {
  @ApiProperty({ example: "0192f291-27dd-7d3f-8071-5f8685deef37" })
  id!: string;

  @ApiProperty({ example: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1" })
  playerId!: string;

  @ApiProperty({ type: MoneyDto })
  balance!: MoneyDto;

  @ApiProperty({ example: 1, description: "Nasce 1, com ou sem OPENING (D6.2)" })
  version!: number;
}

export class LedgerEntryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  transactionId!: string;

  @ApiProperty({ enum: ["DEBIT", "CREDIT"] })
  direction!: string;

  @ApiProperty({ type: MoneyDto })
  money!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  balanceBefore!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  balanceAfter!: MoneyDto;

  @ApiProperty({ example: 1 })
  walletVersion!: number;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;
}

export class LedgerPageDto {
  @ApiProperty({ type: [LedgerEntryDto], description: "Ordem crescente de walletVersion" })
  items!: LedgerEntryDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Cursor opaco da próxima página; null na última (D6.8)",
  })
  nextCursor!: string | null;
}

export class ReconciliationIssueDto {
  @ApiProperty({ enum: ["BALANCE_MISMATCH", "CHAIN_BREAK", "TAIL_MISMATCH"] })
  code!: string;

  @ApiPropertyOptional({ description: "Só no CHAIN_BREAK" })
  walletVersion?: number;
}

export class ReconciliationResponseDto {
  @ApiProperty()
  walletId!: string;

  @ApiProperty({ type: MoneyDto })
  storedBalance!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: "Σ créditos − Σ débitos do ledger" })
  calculatedBalance!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: "Armazenado − calculado, com sinal" })
  difference!: MoneyDto;

  @ApiProperty()
  consistent!: boolean;

  @ApiProperty({ example: 42 })
  checkedEntries!: number;

  @ApiProperty({ type: [ReconciliationIssueDto], description: "Vazia quando consistente (D16.5)" })
  issues!: ReconciliationIssueDto[];
}
