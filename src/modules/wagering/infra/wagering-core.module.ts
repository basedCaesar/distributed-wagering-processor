import { Module } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  CLOCK,
  type Clock,
  ID_GENERATOR,
  type IdGenerator,
  UNIT_OF_WORK,
} from "../application/ports";
import { MikroOrmUnitOfWork } from "./persistence/mikro-orm-unit-of-work";

/**
 * Adaptadores comuns a todos os processos do contexto `wagering` (D7.4):
 * a unidade de trabalho sobre o MikroORM, os ids (D6.6) e o relógio.
 */
@Module({
  providers: [
    {
      provide: UNIT_OF_WORK,
      useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm),
      inject: [MikroORM],
    },
    {
      provide: ID_GENERATOR,
      useValue: { next: () => Bun.randomUUIDv7() } satisfies IdGenerator,
    },
    { provide: CLOCK, useValue: { now: () => new Date() } satisfies Clock },
  ],
  exports: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
})
export class WageringCoreModule {}
