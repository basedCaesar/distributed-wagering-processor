import { Global, Module } from "@nestjs/common";
import { logger } from "./logger";

/** Logger injetável: os testes trocam por um que guarda as linhas. */
export const LOGGER = Symbol("LOGGER");

@Global()
@Module({
  providers: [{ provide: LOGGER, useValue: logger }],
  exports: [LOGGER],
})
export class LoggerModule {}
