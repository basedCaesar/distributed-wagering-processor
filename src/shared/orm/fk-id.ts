import type { EntitySchema, EntitySchemaProperty } from "@mikro-orm/core";

/**
 * Coluna de FK mapeada como o id (string) no record, mas declarada como
 * `m:1` com `mapToPk` para o ORM saber a ordem dos INSERTs no flush
 * (wallet → transação → lançamento). Os records são objetos planos, então
 * a tipagem do `m:1` (que espera a entidade no lugar do id) não se aplica;
 * o cast fica só aqui.
 */
export function fkId<Owner>(
  target: () => EntitySchema,
  fieldName: string,
  options: { nullable?: boolean } = {},
): EntitySchemaProperty<string, Owner> {
  return {
    kind: "m:1",
    entity: target,
    fieldName,
    mapToPk: true,
    nullable: options.nullable ?? false,
  } as unknown as EntitySchemaProperty<string, Owner>;
}
