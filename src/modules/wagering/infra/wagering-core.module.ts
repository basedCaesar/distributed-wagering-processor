import { Module } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { ID_GENERATOR, type IdGenerator, UNIT_OF_WORK } from "../application/ports";
import { MikroOrmUnitOfWork } from "./persistence/mikro-orm-unit-of-work";

/**
 * Adaptadores comuns a todos os processos do contexto `wagering` (D7.4):
 * a unidade de trabalho sobre o MikroORM e os ids (D6.6). Não há relógio
 * da aplicação: todo horário gravado vem do `now()` da transação (D18.12).
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
  ],
  exports: [UNIT_OF_WORK, ID_GENERATOR],
})
export class WageringCoreModule {}
