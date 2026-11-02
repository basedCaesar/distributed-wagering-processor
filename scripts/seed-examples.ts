import { WalletAlreadyExistsError } from "../src/modules/wagering/application/errors";
import { OpenWalletUseCase } from "../src/modules/wagering/application/open-wallet.use-case";
import type { IdGenerator } from "../src/modules/wagering/application/ports";
import { Money } from "../src/modules/wagering/domain/money";
import { WAGERING_ENTITIES } from "../src/modules/wagering/infra/persistence";
import { MikroOrmUnitOfWork } from "../src/modules/wagering/infra/persistence/mikro-orm-unit-of-work";
import { classifyError } from "../src/shared/errors/classify-error";
import { createOrm } from "../src/shared/orm/create-orm";
import { EnvSecretsProvider } from "../src/shared/secrets/env-secrets-provider";

/**
 * Seed do Compose de dev (D23.1): a wallet que os exemplos do §9 (BET,
 * R-09-10) e do §10 usam, com o mesmo id do enunciado. Passa pelo
 * `OpenWalletUseCase` real (wallet, `OPENING`, lançamento e outbox numa
 * transação, papel da app). Rodar de novo não faz nada: a wallet já existe.
 */
const EXAMPLE_WALLET_ID = "0192f291-27dd-7d3f-8071-5f8685deef37";
const EXAMPLE_PLAYER_ID = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";

/**
 * O `OpenWalletUseCase` pede o id da wallet primeiro; os seguintes
 * (`OPENING`, lançamento, eventos) são UUIDv7 novos, como na api (D6.6).
 */
function exampleIds(): IdGenerator {
  let first = true;
  return {
    next: () => {
      if (!first) return Bun.randomUUIDv7();
      first = false;
      return EXAMPLE_WALLET_ID;
    },
  };
}

async function main(): Promise<void> {
  const credentials = await new EnvSecretsProvider().getDatabaseCredentials();
  const orm = await createOrm({ credentials, entities: WAGERING_ENTITIES, applicationName: "seed" });
  try {
    const useCase = new OpenWalletUseCase(new MikroOrmUnitOfWork(orm), exampleIds());
    const wallet = await useCase.execute(
      {
        playerId: EXAMPLE_PLAYER_ID,
        initialBalance: Money.from({ amount: "1000.00", currency: "BRL" }),
      },
      { correlationId: "seed-examples", causationId: Bun.randomUUIDv7() },
    );
    if (wallet.id !== EXAMPLE_WALLET_ID) {
      throw new Error(`seed criou a wallet ${wallet.id}, não a do exemplo`);
    }
    console.log(`seed: wallet do exemplo criada (${wallet.id})`);
  } catch (error) {
    if (error instanceof WalletAlreadyExistsError) {
      console.log("seed: a wallet do exemplo já existe; nada a fazer");
      return;
    }
    throw error;
  } finally {
    await orm.close();
  }
}

main().catch((error) => {
  // Só o que o classifyError considera seguro (D22.9 e): nada do erro do pg.
  const classified = classifyError(error);
  console.error(`seed falhou: ${classified.code} ${classified.message}`);
  process.exit(1);
});
