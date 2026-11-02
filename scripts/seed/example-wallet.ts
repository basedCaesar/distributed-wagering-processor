import type { MikroORM } from "@mikro-orm/postgresql";
import { WalletAlreadyExistsError } from "../../src/modules/wagering/application/errors";
import { OpenWalletUseCase } from "../../src/modules/wagering/application/open-wallet.use-case";
import type { IdGenerator } from "../../src/modules/wagering/application/ports";
import { Money } from "../../src/modules/wagering/domain/money";
import { MikroOrmUnitOfWork } from "../../src/modules/wagering/infra/persistence/mikro-orm-unit-of-work";
import { ConflictError } from "../../src/shared/errors/app-errors";

/** A wallet que os exemplos do §9 (BET, R-09-10) e do §10 usam (D23.1). */
export const EXAMPLE_WALLET = {
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
} as const;

export interface ExampleWallet {
  walletId: string;
  playerId: string;
}

export type SeedOutcome = "created" | "already-exists";

/**
 * Já existe wallet desse player e moeda, mas com outro id (D23.1): os
 * exemplos do §9 e do §10 dariam `404`. Código próprio, que o
 * `classifyError` mantém (categoria conflito); a mensagem não traz o
 * `playerId` (D11.1).
 */
export class SeedExampleWalletMismatchError extends ConflictError {
  constructor(expectedWalletId: string, existingWalletId: string) {
    super(
      "SEED_EXAMPLE_WALLET_MISMATCH",
      `já existe uma wallet do player do exemplo com outro id (${existingWalletId}, esperado ${expectedWalletId}); ` +
        "os exemplos do §9 e do §10 dariam 404. Para recomeçar com o banco limpo: bun run infra:down -v && bun run infra:up",
      { expectedWalletId, existingWalletId },
    );
  }
}

/**
 * O `OpenWalletUseCase` pede o id da wallet primeiro; os seguintes
 * (`OPENING`, lançamento, eventos) são UUIDv7 novos, como na api (D6.6).
 */
function exampleIds(walletId: string): IdGenerator {
  let first = true;
  return {
    next: () => {
      if (!first) return Bun.randomUUIDv7();
      first = false;
      return walletId;
    },
  };
}

const CURRENCY = "BRL";

function existing(example: ExampleWallet, walletId: string): SeedOutcome {
  if (walletId === example.walletId) return "already-exists";
  throw new SeedExampleWalletMismatchError(example.walletId, walletId);
}

/**
 * Cria a wallet do exemplo pelo `OpenWalletUseCase` real (wallet, `OPENING`,
 * lançamento e outbox numa transação, papel da app), com `1000.00 BRL`.
 *
 * Antes, procura a wallet do player na moeda (D23.1): com a wallet do exemplo
 * já criada, o `INSERT` bateria primeiro no `wallets_pk`, que não vira
 * `WalletAlreadyExistsError`. O `WalletAlreadyExistsError` continua tratado
 * para a corrida entre a busca e o `INSERT`. Em ambos, id igual → nada a
 * fazer; id diferente → `SEED_EXAMPLE_WALLET_MISMATCH`.
 */
export async function seedExampleWallet(orm: MikroORM, example: ExampleWallet): Promise<SeedOutcome> {
  const uow = new MikroOrmUnitOfWork(orm);
  const found = await uow.run((tx) => tx.wallets.findIdByPlayerAndCurrency(example.playerId, CURRENCY));
  if (found !== undefined) return existing(example, found);

  const useCase = new OpenWalletUseCase(uow, exampleIds(example.walletId));
  try {
    await useCase.execute(
      {
        playerId: example.playerId,
        initialBalance: Money.from({ amount: "1000.00", currency: CURRENCY }),
      },
      { correlationId: "seed-examples", causationId: Bun.randomUUIDv7() },
    );
    return "created";
  } catch (error) {
    if (error instanceof WalletAlreadyExistsError) return existing(example, error.walletId);
    throw error;
  }
}
