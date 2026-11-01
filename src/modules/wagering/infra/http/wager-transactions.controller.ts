import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { CurrentIdentity, Roles } from "../../../../shared/auth/auth.decorators";
import type { Identity } from "../../../../shared/auth/provider-identity.port";
import type { AppConfig } from "../../../../shared/config/config.schema";
import { APP_CONFIG } from "../../../../shared/config/config.module";
import { ForbiddenError } from "../../../../shared/errors/app-errors";
import {
  CurrentRequestMeta,
  type RequestMeta,
} from "../../../../shared/http/correlation.middleware";
import { ApiErrorResponses } from "../../../../shared/http/error-responses";
import { parseOrThrow } from "../../../../shared/http/zod";
// biome-ignore lint/style/useImportType: NestJS resolve a injeção pelo tipo do construtor em runtime
import { SubmitWagerTransactionUseCase } from "../../application/submit-wager-transaction.use-case";
// biome-ignore lint/style/useImportType: NestJS resolve a injeção pelo tipo do construtor em runtime
import { TransactionQueries, type TransactionViewer } from "../../application/transaction-queries";
import {
  SubmitTransactionRequestDto,
  SubmitTransactionResponseDto,
  TransactionResponseDto,
} from "./wager-transaction.dto";
import {
  presentSubmission,
  presentTransaction,
  submissionHttpStatus,
} from "./wager-transaction.presenter";
import {
  idempotencyKeySchema,
  providerIdentifierSchema,
  submitTransactionSchema,
  transactionIdSchema,
} from "./wager-transaction.schemas";

/** O que o guard já garantiu: token válido (D10.4). */
function identityOf(identity: Identity | undefined): Identity {
  if (!identity) throw new Error("AuthGuard não rodou nesta rota");
  return identity;
}

/** Operador vê tudo, inclusive com os dois papéis (D10.2, D16.10). */
function viewerOf(identity: Identity): TransactionViewer {
  if (identity.roles.has("operator")) return { kind: "operator" };
  // O adaptador já recusa `provider` sem `provider_id` com 401 (D16.1).
  if (identity.providerId === undefined) {
    throw new Error("identidade de provider sem providerId");
  }
  return { kind: "provider", providerId: identity.providerId };
}

/**
 * Transações (§9). Permissões da D10.2: submeter só `provider`, com o
 * `providerId` do token; consultar, as próprias (`provider`) ou todas
 * (`operator`).
 */
@ApiTags("wagering")
@ApiBearerAuth()
@Controller()
export class WagerTransactionsController {
  private readonly submitSchema: ReturnType<typeof submitTransactionSchema>;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly submitTransaction: SubmitWagerTransactionUseCase,
    private readonly queries: TransactionQueries,
  ) {
    this.submitSchema = submitTransactionSchema(config.currencies);
  }

  @Post("wagering/transactions")
  @Roles("provider")
  @ApiOperation({
    summary: "Submete uma transação de aposta",
    description:
      "Trava a wallet, checa a idempotência sob o lock e decide na hora (D3.6, D4.1). Replay devolve o estado atual com idempotentReplay: true e o mesmo status (D3.4).",
  })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description: "Fonte da verdade da idempotência, por provedor; até 255 caracteres (R-09-12, D3.1, D5)",
  })
  @ApiBody({ type: SubmitTransactionRequestDto })
  @ApiResponse({ status: 200, type: SubmitTransactionResponseDto, description: "PROCESSED (inclusive LOSS)" })
  @ApiResponse({ status: 202, type: SubmitTransactionResponseDto, description: "PENDING_REFERENCE: referência ainda ausente (D4.1)" })
  @ApiResponse({ status: 422, type: SubmitTransactionResponseDto, description: "REJECTED, com failureCode (D5)" })
  @ApiResponse({ status: 500, type: SubmitTransactionResponseDto, description: "Replay de FAILED (PROCESSING_FAILED, D16.4)" })
  @ApiErrorResponses(400, 401, 403, 404, 409, 503)
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @CurrentIdentity() identity: Identity | undefined,
    @CurrentRequestMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parseOrThrow(this.submitSchema, body, "corpo");
    const key = parseOrThrow(idempotencyKeySchema, idempotencyKey, "Idempotency-Key");
    // A identidade vem do token (D10.2).
    if (input.providerId !== identityOf(identity).providerId) {
      throw new ForbiddenError("providerId do corpo diferente do token");
    }
    const result = await this.submitTransaction.execute(
      {
        ...input,
        idempotencyKey: key,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
      },
      { correlationId: meta.correlationId, causationId: meta.requestId },
    );
    response.status(submissionHttpStatus(result.transaction));
    return presentSubmission(result);
  }

  @Get("wagering/transactions/:transactionId")
  @ApiOperation({ summary: "Consulta uma transação pelo id" })
  @ApiParam({ name: "transactionId", description: "UUID (outro formato → 400, D17.3)" })
  @ApiResponse({ status: 200, type: TransactionResponseDto })
  @ApiErrorResponses(400, 401, 404, 503)
  async getById(
    @Param("transactionId") transactionId: string,
    @CurrentIdentity() identity: Identity | undefined,
  ) {
    const id = parseOrThrow(transactionIdSchema, transactionId, "transactionId");
    return presentTransaction(await this.queries.getById(id, viewerOf(identityOf(identity))));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  @ApiOperation({
    summary: "Consulta uma transação pelo id externo do provedor",
    description: "Um provedor só consulta o próprio providerId; outro → 404 (D10.2).",
  })
  @ApiParam({ name: "providerId", description: "D17.1 (outro formato → 400, D17.3)" })
  @ApiParam({ name: "externalTransactionId", description: "D17.1 (outro formato → 400, D17.3)" })
  @ApiResponse({ status: 200, type: TransactionResponseDto })
  @ApiErrorResponses(400, 401, 404, 503)
  async getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
    @CurrentIdentity() identity: Identity | undefined,
  ) {
    const provider = parseOrThrow(providerIdentifierSchema, providerId, "providerId");
    const externalId = parseOrThrow(
      providerIdentifierSchema,
      externalTransactionId,
      "externalTransactionId",
    );
    return presentTransaction(
      await this.queries.getByExternalId(provider, externalId, viewerOf(identityOf(identity))),
    );
  }
}
