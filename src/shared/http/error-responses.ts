import { applyDecorators } from "@nestjs/common";
import { ApiProperty, ApiPropertyOptional, ApiResponse } from "@nestjs/swagger";

class ErrorDetailDto {
  @ApiProperty({ example: "VALIDATION_ERROR" })
  code!: string;

  @ApiProperty({ example: "Corpo inválido" })
  message!: string;

  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  details?: Record<string, unknown>;
}

/** Corpo de erro sem transação (D5). */
export class ErrorResponseDto {
  @ApiProperty({ type: ErrorDetailDto })
  error!: ErrorDetailDto;
}

const DESCRIPTIONS: Record<number, string> = {
  400: "Payload inválido (VALIDATION_ERROR): decidível só pelo payload, nada gravado",
  401: "Sem token ou token inválido (UNAUTHENTICATED)",
  403: "Token sem o papel exigido (FORBIDDEN)",
  404: "Recurso inexistente (NOT_FOUND)",
  409: "Conflito (WALLET_ALREADY_EXISTS, EXTERNAL_ID_CONFLICT, conflito de idempotência)",
  503: "Falha transitória (TEMPORARILY_UNAVAILABLE), com Retry-After",
};

/** Documenta os status de erro da D5 de um endpoint (D13.2). */
export function ApiErrorResponses(...statuses: number[]) {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: DESCRIPTIONS[status],
        type: ErrorResponseDto,
      }),
    ),
  );
}
