import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Roles } from "../../../../shared/auth/auth.decorators";
import type { AppConfig } from "../../../../shared/config/config.schema";
import { APP_CONFIG } from "../../../../shared/config/config.module";
import { ApiErrorResponses } from "../../../../shared/http/error-responses";
import {
  CurrentRequestMeta,
  type RequestMeta,
} from "../../../../shared/http/correlation.middleware";
import { parseOrThrow } from "../../../../shared/http/zod";
// biome-ignore lint/style/useImportType: NestJS resolve a injeção pelo tipo do construtor em runtime
import { OpenWalletUseCase } from "../../application/open-wallet.use-case";
// biome-ignore lint/style/useImportType: NestJS resolve a injeção pelo tipo do construtor em runtime
import { ReconcileWalletUseCase } from "../../application/reconcile-wallet.use-case";
// biome-ignore lint/style/useImportType: NestJS resolve a injeção pelo tipo do construtor em runtime
import { WalletQueries } from "../../application/wallet-queries";
import {
  CreateWalletRequestDto,
  LedgerPageDto,
  ReconciliationResponseDto,
  WalletResponseDto,
} from "./wallet.dto";
import {
  presentLedgerPage,
  presentReconciliation,
  presentWallet,
} from "./wallet.presenter";
import {
  createWalletSchema,
  ledgerQuerySchema,
  walletIdSchema,
} from "./wallet.schemas";

const WALLET_ID_PARAM = {
  name: "walletId",
  description: "UUID da wallet (outro formato → 400, D16.8)",
};

/**
 * Wallets (§9). Permissões da D10.2: criar e reconciliar só `operator`;
 * consultar, `provider` e `operator`.
 */
@ApiTags("wallets")
@ApiBearerAuth()
@Controller("wallets")
export class WalletsController {
  private readonly createWallet: ReturnType<typeof createWalletSchema>;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly openWallet: OpenWalletUseCase,
    private readonly queries: WalletQueries,
    private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {
    this.createWallet = createWalletSchema(config.currencies);
  }

  @Post()
  @Roles("operator")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Cria uma wallet",
    description:
      "Saldo inicial maior que zero gera a OPENING e o CREDIT na mesma transação SQL (R-09-03).",
  })
  @ApiBody({ type: CreateWalletRequestDto })
  @ApiResponse({ status: 201, type: WalletResponseDto })
  @ApiErrorResponses(400, 401, 403, 409, 503)
  async create(@Body() body: unknown, @CurrentRequestMeta() meta: RequestMeta) {
    const command = parseOrThrow(this.createWallet, body, "corpo");
    const wallet = await this.openWallet.execute(command, {
      correlationId: meta.correlationId,
      causationId: meta.requestId,
    });
    return presentWallet(wallet);
  }

  @Get(":walletId")
  @ApiOperation({ summary: "Consulta uma wallet" })
  @ApiParam(WALLET_ID_PARAM)
  @ApiResponse({ status: 200, type: WalletResponseDto })
  @ApiErrorResponses(400, 401, 404, 503)
  async get(@Param("walletId") walletId: string) {
    const id = parseOrThrow(walletIdSchema, walletId, "walletId");
    return presentWallet(await this.queries.getWallet(id));
  }

  @Get(":walletId/ledger")
  @ApiOperation({
    summary: "Lançamentos da wallet",
    description: "Ordem crescente de walletVersion; cursor estável e opaco (D6.8).",
  })
  @ApiParam(WALLET_ID_PARAM)
  @ApiQuery({ name: "cursor", required: false })
  @ApiQuery({ name: "limit", required: false, description: "1 a 200, padrão 50" })
  @ApiResponse({ status: 200, type: LedgerPageDto })
  @ApiErrorResponses(400, 401, 404, 503)
  async ledger(@Param("walletId") walletId: string, @Query() query: unknown) {
    const id = parseOrThrow(walletIdSchema, walletId, "walletId");
    const { cursor, limit } = parseOrThrow(ledgerQuerySchema, query, "query");
    return presentLedgerPage(
      await this.queries.listLedger(id, {
        limit,
        ...(cursor !== undefined && { cursor }),
      }),
    );
  }

  @Post(":walletId/reconciliation")
  @Roles("operator")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Reconcilia saldo e ledger",
    description:
      "Sempre 200; divergência vem com consistent: false e issues, é logada e contada. Nada é corrigido (D6.9).",
  })
  @ApiParam(WALLET_ID_PARAM)
  @ApiResponse({ status: 200, type: ReconciliationResponseDto })
  @ApiErrorResponses(400, 401, 403, 404, 503)
  async reconcile(@Param("walletId") walletId: string) {
    const id = parseOrThrow(walletIdSchema, walletId, "walletId");
    return presentReconciliation(await this.reconcileWallet.execute(id));
  }
}
