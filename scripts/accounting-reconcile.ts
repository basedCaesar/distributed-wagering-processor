/**
 * `bun run accounting:reconcile [--player-prefix <p>] [--wait <s>]` (D27.7).
 *
 * Reconcilia o diário de partidas dobradas com o núcleo: lê o accounting
 * com o `accounting_app` e, **depois**, o núcleo com o `wagering_app` (o
 * diário só pode estar atrás do núcleo, nunca à frente). Só reporta,
 * nunca corrige (D6.9).
 *
 * - sai com 1 se houver divergência ou trial balance ≠ 0;
 * - com `--wait`, repete até não haver wallet atrasada nem par incompleto
 *   e sai com 1 se o prazo acabar antes.
 *
 * A saída tem contagens, ids de wallet e códigos de problema; nunca
 * valores nem saldos (D11.1). Conexão: `DB_HOST`, `DB_PORT`, `DB_NAME`,
 * `DB_USER`/`DB_PASSWORD` (o papel da app) e
 * `DB_ACCOUNTING_USER`/`DB_ACCOUNTING_PASSWORD`.
 */
import { Client } from "pg";
import {
  type AccountingReconciliationReport,
  reconcileAccounting,
} from "../src/modules/accounting/domain/accounting-reconciliation";
import {
  type QueryRows,
  readAccountingState,
  readCoreWallets,
} from "../src/modules/accounting/infra/persistence/accounting-reconciliation-reader";

interface Options {
  playerPrefix?: string;
  waitSeconds: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { waitSeconds: 0 };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--player-prefix" && value !== undefined) {
      options.playerPrefix = value;
      index++;
    } else if (arg === "--wait" && value !== undefined && /^[0-9]{1,4}$/.test(value)) {
      options.waitSeconds = Number.parseInt(value, 10);
      index++;
    } else {
      throw new Error(`argumento inválido: ${arg ?? ""} (use --player-prefix <p> e --wait <segundos>)`);
    }
  }
  return options;
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} não definido`);
  return value;
}

async function withRole<T>(user: string, password: string, fn: (query: QueryRows) => Promise<T>): Promise<T> {
  const client = new Client({
    host: env("DB_HOST"),
    port: Number.parseInt(env("DB_PORT"), 10),
    database: env("DB_NAME"),
    user,
    password,
    application_name: "accounting-reconcile",
  });
  await client.connect();
  try {
    return await fn((sql, params) => client.query(sql, params).then((result) => result.rows));
  } finally {
    await client.end();
  }
}

async function reconcileOnce(options: Options): Promise<AccountingReconciliationReport> {
  const app = { user: env("DB_USER"), password: env("DB_PASSWORD") };
  const accountingRole = { user: env("DB_ACCOUNTING_USER"), password: env("DB_ACCOUNTING_PASSWORD") };
  // Com prefixo, as wallets vêm do núcleo; o saldo dele é lido de novo depois do accounting.
  const walletIds =
    options.playerPrefix === undefined
      ? undefined
      : (await withRole(app.user, app.password, (q) => readCoreWallets(q, { playerPrefix: options.playerPrefix }))).map(
          (wallet) => wallet.walletId,
        );
  const accounting = await withRole(accountingRole.user, accountingRole.password, (q) =>
    readAccountingState(q, walletIds === undefined ? {} : { walletIds }),
  );
  const core = await withRole(app.user, app.password, (q) =>
    readCoreWallets(q, walletIds === undefined ? {} : { walletIds }),
  );
  return reconcileAccounting({ ...accounting, core });
}

function summary(report: AccountingReconciliationReport): Record<string, unknown> {
  return {
    consistent: report.consistent,
    settled: report.settled,
    wallets: report.wallets.length,
    counts: report.counts,
    incompletePairs: report.incompletePairs,
    trialBalance: report.trialBalance.map((row) => ({ currency: row.currency, balanced: row.balanced })),
    divergent: report.wallets
      .filter((wallet) => wallet.status === "divergent")
      .slice(0, 50)
      .map((wallet) => ({ walletId: wallet.walletId, issues: wallet.issues })),
  };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + options.waitSeconds * 1000;
  let report = await reconcileOnce(options);
  while (options.waitSeconds > 0 && report.consistent && !report.settled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    report = await reconcileOnce(options);
  }
  console.log(JSON.stringify(summary(report), null, 2));
  if (!report.consistent) {
    console.error("accounting:reconcile: divergência entre o diário e o núcleo (D27.7)");
    return 1;
  }
  if (options.waitSeconds > 0 && !report.settled) {
    console.error(`accounting:reconcile: o diário não alcançou o núcleo em ${options.waitSeconds} s (D27.7)`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`accounting:reconcile falhou: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
