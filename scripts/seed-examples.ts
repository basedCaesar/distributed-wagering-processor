import { WAGERING_ENTITIES } from "../src/modules/wagering/infra/persistence";
import { classifyError } from "../src/shared/errors/classify-error";
import { createOrm } from "../src/shared/orm/create-orm";
import { EnvSecretsProvider } from "../src/shared/secrets/env-secrets-provider";
import { EXAMPLE_WALLET, seedExampleWallet } from "./seed/example-wallet";

/**
 * Seed do Compose de dev (D23.1): a wallet que os exemplos do §9 (BET,
 * R-09-10) e do §10 usam, com o mesmo id do enunciado. A lógica fica em
 * `seed/example-wallet.ts` (testada em `test/integration/seed/`). Rodar de
 * novo não faz nada; wallet do player com outro id → `SEED_EXAMPLE_WALLET_MISMATCH`.
 */
async function main(): Promise<void> {
  const credentials = await new EnvSecretsProvider().getDatabaseCredentials();
  const orm = await createOrm({ credentials, entities: WAGERING_ENTITIES, applicationName: "seed" });
  try {
    const outcome = await seedExampleWallet(orm, EXAMPLE_WALLET);
    console.log(
      outcome === "created"
        ? `seed: wallet do exemplo criada (${EXAMPLE_WALLET.walletId})`
        : "seed: a wallet do exemplo já existe; nada a fazer",
    );
  } finally {
    await orm.close();
  }
}

main().catch((error) => {
  // Só o que o classifyError considera seguro (D22.9 e): o código próprio do
  // seed e a mensagem dele; nada do erro do pg.
  const classified = classifyError(error);
  console.error(`seed falhou: ${classified.code} ${classified.message}`);
  process.exit(1);
});
