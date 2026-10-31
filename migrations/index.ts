import type { MigrationObject } from "@mikro-orm/core";
import { Migration20261030000001_wallets } from "./Migration20261030000001_wallets";
import { Migration20261030000002_wager_transactions } from "./Migration20261030000002_wager_transactions";
import { Migration20261030000003_wallet_ledger_entries } from "./Migration20261030000003_wallet_ledger_entries";
import { Migration20261030000004_wallet_ledger_tail } from "./Migration20261030000004_wallet_ledger_tail";
import { Migration20261030000005_messaging } from "./Migration20261030000005_messaging";
import { Migration20261030000006_reconciliation_runs } from "./Migration20261030000006_reconciliation_runs";
import { Migration20261030000007_ledger_transaction_coherence } from "./Migration20261030000007_ledger_transaction_coherence";

/** Ordem de aplicação. Migration aplicada nunca é editada: crie outra. */
export const MIGRATIONS: MigrationObject[] = [
  Migration20261030000001_wallets,
  Migration20261030000002_wager_transactions,
  Migration20261030000003_wallet_ledger_entries,
  Migration20261030000004_wallet_ledger_tail,
  Migration20261030000005_messaging,
  Migration20261030000006_reconciliation_runs,
  Migration20261030000007_ledger_transaction_coherence,
].map((migration) => ({ name: migration.name, class: migration }));
