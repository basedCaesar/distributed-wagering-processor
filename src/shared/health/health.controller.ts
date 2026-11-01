import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { Public } from "../auth/auth.decorators";
// biome-ignore lint/style/useImportType: NestJS resolve a injeção pelo tipo do construtor em runtime
import { HealthService } from "./health.service";

/** Aberto, sem token (R-02-06, R-09-20..22). */
@ApiTags("health")
@Public()
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get("live")
  @ApiOkResponse({ description: "Processo vivo" })
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  @ApiOkResponse({ description: "PostgreSQL e SQS alcançáveis" })
  @ApiServiceUnavailableResponse({
    description: "PostgreSQL ou SQS inalcançável (timeout de 1 s cada, D11.3)",
  })
  async ready(@Res({ passthrough: true }) res: Response) {
    const result = await this.healthService.checkReady();
    res.status(result.ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
