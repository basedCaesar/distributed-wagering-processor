import { describe, expect, it } from "bun:test";
import type { Client } from "pg";
import { connect, expectDbError, newId, withClient } from "../../support/db";

/**
 * D27.3: as garantias do diário estão no banco, como as do núcleo (D7.3).
 * Os testes gravam direto, como `accounting_app` (o papel do processo), e
 * provam com o dono o que o privilégio esconderia (o trigger append-only).
 */

interface Line {
  account: string;
  direction: "DEBIT" | "CREDIT";
  amount: string;
  currency?: string;
}

/** Conta da casa (uma por código e moeda), criada se faltar. */
async function houseAccount(client: Client, code: string, currency = "BRL"): Promise<string> {
  const nature: Record<string, string> = {
    HOUSE_OPENING_FUNDS: "ASSET",
    HOUSE_WAGERS_RECEIVED: "REVENUE",
    HOUSE_PAYOUTS: "EXPENSE",
    HOUSE_REFUNDS: "CONTRA_REVENUE",
    HOUSE_ROLLBACKS: "ADJUSTMENT",
  };
  await client.query(
    `INSERT INTO accounting.accounts (id, code, nature, currency, wallet_id)
     VALUES ($1, $2, $3, $4, NULL)
     ON CONFLICT (code, currency) WHERE wallet_id IS NULL DO NOTHING`,
    [newId(), code, nature[code], currency],
  );
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM accounting.accounts WHERE code = $1 AND currency = $2 AND wallet_id IS NULL",
    [code, currency],
  );
  return rows[0]?.id as string;
}

async function playerAccount(client: Client, walletId: string, currency = "BRL"): Promise<string> {
  const id = newId();
  await client.query(
    `INSERT INTO accounting.accounts (id, code, nature, currency, wallet_id)
     VALUES ($1, 'PLAYER_WALLET', 'LIABILITY', $2, $3)`,
    [id, currency, walletId],
  );
  return id;
}

/** As duas metades de uma BET de `amount` (D27.1), gravadas em `received_events`. */
async function halves(client: Client, walletId: string, transactionId: string, amount = "25.00") {
  const balanceEventId = newId();
  const processedEventId = newId();
  await client.query(
    `INSERT INTO accounting.received_events
       (event_id, event_type, transaction_id, wallet_id, wallet_version, currency, amount,
        kind, direction, balance_before, balance_after, occurred_at, received_at)
     VALUES ($1, 'WalletBalanceChanged', $2, $3, 2, 'BRL', $4, NULL, 'DEBIT', 100.00, 100.00 - $4::numeric, now(), now()),
            ($5, 'WagerTransactionProcessed', $2, $3, 2, 'BRL', $4, 'BET', NULL, NULL, 100.00 - $4::numeric, now(), now())`,
    [balanceEventId, transactionId, walletId, amount, processedEventId],
  );
  return { balanceEventId, processedEventId };
}

/**
 * Um lançamento com as linhas dadas, numa transação aberta (o teste dá o
 * COMMIT): o balanceamento é diferido, então só o COMMIT falha.
 */
async function insertEntry(
  client: Client,
  lines: Line[],
  options: { walletId?: string; transactionId?: string; halvesTransactionId?: string } = {},
) {
  const walletId = options.walletId ?? newId();
  const transactionId = options.transactionId ?? newId();
  await client.query(
    `INSERT INTO accounting.accounts (id, code, nature, currency, wallet_id)
     VALUES ($1, 'PLAYER_WALLET', 'LIABILITY', 'BRL', $2) ON CONFLICT (wallet_id) DO NOTHING`,
    [newId(), walletId],
  );
  const { rows } = await client.query<{ id: string }>("SELECT id FROM accounting.accounts WHERE wallet_id = $1", [walletId]);
  const player = rows[0]?.id as string;
  const { balanceEventId, processedEventId } = await halves(client, walletId, options.halvesTransactionId ?? transactionId);
  const entryId = newId();
  await client.query(
    `INSERT INTO accounting.journal_entries
       (id, transaction_id, wallet_id, wallet_version, kind, currency, balance_event_id, processed_event_id, occurred_at, posted_at)
     VALUES ($1, $2, $3, 2, 'BET', 'BRL', $4, $5, now(), now())`,
    [entryId, transactionId, walletId, balanceEventId, processedEventId],
  );
  let lineNo = 0;
  for (const line of lines) {
    const accountId = line.account === "PLAYER_WALLET" ? player : await houseAccount(client, line.account, line.currency ?? "BRL");
    lineNo += 1;
    await client.query(
      `INSERT INTO accounting.journal_lines (entry_id, line_no, account_id, direction, amount, currency)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entryId, lineNo, accountId, line.direction, line.amount, line.currency ?? "BRL"],
    );
  }
  return { entryId, walletId, transactionId };
}

const BALANCED: Line[] = [
  { account: "PLAYER_WALLET", direction: "DEBIT", amount: "25.00" },
  { account: "HOUSE_WAGERS_RECEIVED", direction: "CREDIT", amount: "25.00" },
];

/** Grava um lançamento balanceado e commitado; devolve os ids. */
async function committedEntry() {
  return withClient("accounting", async (client) => {
    await client.query("BEGIN");
    const ids = await insertEntry(client, BALANCED);
    await client.query("COMMIT");
    return ids;
  });
}

/** Abre a transação, grava e devolve o COMMIT como a operação que precisa falhar. */
async function commitOf(lines: Line[]): Promise<void> {
  const client = await connect("accounting");
  try {
    await client.query("BEGIN");
    await insertEntry(client, lines);
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
}

describe("D27.3: valores e tipos do diário", () => {
  it("D2 D27.3: todo valor do schema accounting é numeric(20,2) e toda moeda é char(3)", async () => {
    const columns = await withClient("owner", async (client) => {
      const { rows } = await client.query<{ name: string; type: string; precision: number | null; scale: number | null; length: number | null }>(
        `SELECT table_name || '.' || column_name AS name, data_type AS type,
                numeric_precision AS precision, numeric_scale AS scale, character_maximum_length AS length
           FROM information_schema.columns
          WHERE table_schema = 'accounting'
            AND (column_name IN ('amount', 'balance_before', 'balance_after') OR column_name = 'currency')
          ORDER BY 1`,
      );
      return rows;
    });

    expect(columns.length).toBeGreaterThanOrEqual(6);
    for (const column of columns) {
      const expected = column.name.endsWith(".currency")
        ? { name: column.name, type: "character", precision: null, scale: null, length: 3 }
        : { name: column.name, type: "numeric", precision: 20, scale: 2, length: null };
      expect(column).toEqual(expected);
    }
  });

  it("D27.3: linha com valor zero → CHECK", async () => {
    await expectDbError(
      commitOf([
        { account: "PLAYER_WALLET", direction: "DEBIT", amount: "0.00" },
        { account: "HOUSE_WAGERS_RECEIVED", direction: "CREDIT", amount: "0.00" },
      ]),
      { code: "23514", constraint: "journal_lines_amount_positive_ck" },
    );
  });

  it("D27.3: linha numa moeda diferente da do lançamento → FK", async () => {
    await expectDbError(
      commitOf([
        { account: "PLAYER_WALLET", direction: "DEBIT", amount: "25.00" },
        { account: "HOUSE_WAGERS_RECEIVED", direction: "CREDIT", amount: "25.00", currency: "USD" },
      ]),
      { code: "23503", constraint: "journal_lines_entry_currency_fk" },
    );
  });
});

describe("§6.4 D27.3: débito = crédito em cada lançamento (trigger diferido, no COMMIT)", () => {
  it("D27.3: lançamento balanceado com 2 linhas commita", async () => {
    const { entryId } = await committedEntry();

    const { rows } = await withClient("accounting", (client) =>
      client.query<{ n: number }>("SELECT count(*)::int AS n FROM accounting.journal_lines WHERE entry_id = $1", [entryId]),
    );
    expect(rows[0]?.n).toBe(2);
  });

  it("§6.4 D27.3: débitos ≠ créditos → o COMMIT falha", async () => {
    await expectDbError(
      commitOf([
        { account: "PLAYER_WALLET", direction: "DEBIT", amount: "25.00" },
        { account: "HOUSE_WAGERS_RECEIVED", direction: "CREDIT", amount: "24.99" },
      ]),
      { code: "23000", constraint: "journal_entries_balanced" },
    );
  });

  it("D27.3: lançamento com uma linha só → o COMMIT falha", async () => {
    await expectDbError(commitOf([{ account: "PLAYER_WALLET", direction: "DEBIT", amount: "25.00" }]), {
      code: "23000",
      constraint: "journal_entries_balanced",
    });
  });

  it("D27.3: lançamento sem linhas → o COMMIT falha", async () => {
    await expectDbError(commitOf([]), { code: "23000", constraint: "journal_entries_balanced" });
  });

  it("D27.3: lançamento balanceado sem linha da conta da wallet → o COMMIT falha", async () => {
    await expectDbError(
      commitOf([
        { account: "HOUSE_PAYOUTS", direction: "DEBIT", amount: "25.00" },
        { account: "HOUSE_WAGERS_RECEIVED", direction: "CREDIT", amount: "25.00" },
      ]),
      { code: "23000", constraint: "journal_entries_player_line" },
    );
  });
});

describe("D27.3: unicidades do diário", () => {
  it("D27.3 D27.4: outra metade do mesmo tipo para a mesma transação (outro eventId) → UNIQUE", async () => {
    const first = await committedEntry();

    await expectDbError(
      withClient("accounting", async (client) => {
        await client.query("BEGIN");
        await insertEntry(client, BALANCED, { walletId: first.walletId, transactionId: first.transactionId });
        await client.query("COMMIT");
      }),
      { code: "23505", constraint: "received_events_transaction_type_uq" },
    );
  });

  it("D27.3: segundo lançamento da mesma transação (com outras metades) → UNIQUE", async () => {
    const first = await committedEntry();

    await expectDbError(
      withClient("accounting", async (client) => {
        await client.query("BEGIN");
        await insertEntry(client, BALANCED, { transactionId: first.transactionId, halvesTransactionId: newId() });
        await client.query("COMMIT");
      }),
      { code: "23505", constraint: "journal_entries_transaction_uq" },
    );
  });

  it("D27.3: dois lançamentos apontando para a mesma metade (eventId) → UNIQUE", async () => {
    const first = await committedEntry();

    await expectDbError(
      withClient("accounting", async (client) => {
        const { rows } = await client.query<{ balance_event_id: string; processed_event_id: string }>(
          "SELECT balance_event_id, processed_event_id FROM accounting.journal_entries WHERE id = $1",
          [first.entryId],
        );
        await client.query(
          `INSERT INTO accounting.journal_entries
             (id, transaction_id, wallet_id, wallet_version, kind, currency, balance_event_id, processed_event_id, occurred_at, posted_at)
           VALUES ($1, $2, $3, 3, 'BET', 'BRL', $4, $5, now(), now())`,
          [newId(), newId(), first.walletId, rows[0]?.balance_event_id, rows[0]?.processed_event_id],
        );
      }),
      { code: "23505", constraint: "journal_entries_balance_event_uq" },
    );
  });

  it("D27.3: duas contas PLAYER_WALLET para a mesma wallet → UNIQUE", async () => {
    const walletId = newId();
    await withClient("accounting", (client) => playerAccount(client, walletId));

    await expectDbError(withClient("accounting", (client) => playerAccount(client, walletId)), {
      code: "23505",
      constraint: "accounts_wallet_uq",
    });
  });
});

const APPEND_ONLY_TABLES = ["accounts", "received_events", "journal_entries", "journal_lines"] as const;

describe("D27.3: diário append-only (privilégio e trigger)", () => {
  for (const table of APPEND_ONLY_TABLES) {
    it(`D27.3: accounting_app sem UPDATE, DELETE e TRUNCATE em accounting.${table}`, async () => {
      await committedEntry();
      await withClient("accounting", async (client) => {
        await expectDbError(client.query(`UPDATE accounting.${table} SET currency = currency`), { code: "42501" });
        await expectDbError(client.query(`DELETE FROM accounting.${table}`), { code: "42501" });
        await expectDbError(client.query(`TRUNCATE accounting.${table} CASCADE`), { code: "42501" });
      });
    });

    it(`D27.3: nem o dono faz UPDATE ou DELETE em accounting.${table} (trigger append-only)`, async () => {
      await committedEntry();
      await withClient("owner", async (client) => {
        const constraint = `${table}_append_only`;
        await expectDbError(client.query(`UPDATE accounting.${table} SET currency = currency`), { code: "23000", constraint });
        await expectDbError(client.query(`DELETE FROM accounting.${table}`), { code: "23000", constraint });
      });
    });
  }

  it("D27.3: nem o dono faz TRUNCATE das tabelas do diário (trigger append-only)", async () => {
    await committedEntry();
    await withClient("owner", async (client) => {
      // As 4 juntas: um TRUNCATE só de uma tabela referenciada por FK nem chega ao trigger.
      let caught: { code?: string; constraint?: string } | undefined;
      try {
        await client.query(`TRUNCATE ${APPEND_ONLY_TABLES.map((table) => `accounting.${table}`).join(", ")}`);
      } catch (error) {
        caught = error as { code?: string; constraint?: string };
      }
      expect(caught?.code).toBe("23000");
      expect(caught?.constraint ?? "").toMatch(/^(accounts|received_events|journal_entries|journal_lines)_append_only$/);
    });
  });
});

describe("D27.3 D12.2: papéis isolados", () => {
  it("D27.3: accounting_app não lê nem escreve nas tabelas do núcleo (nem enxerga o schema public)", async () => {
    await withClient("accounting", async (client) => {
      // Qualificado: sem USAGE no public, o nome solto nem resolve (42P01).
      await expectDbError(client.query("SELECT 1 FROM public.wallets LIMIT 1"), { code: "42501" });
      await expectDbError(client.query("SELECT 1 FROM public.wallet_ledger_entries LIMIT 1"), { code: "42501" });
      await expectDbError(client.query("SELECT 1 FROM public.outbox_messages LIMIT 1"), { code: "42501" });
    });
  });

  it("D27.3: wagering_app não lê nem escreve no schema accounting", async () => {
    await withClient("app", async (client) => {
      await expectDbError(client.query("SELECT 1 FROM accounting.journal_entries LIMIT 1"), { code: "42501" });
      await expectDbError(
        client.query("INSERT INTO accounting.inbox_messages (consumer_name, message_id, payload_hash, processed_at) VALUES ('x', 'y', $1, now())", [
          "0".repeat(64),
        ]),
        { code: "42501" },
      );
    });
  });

  it("D19.11 D27.3: accounting_app apaga só as tentativas (message_attempts), não a inbox", async () => {
    await withClient("accounting", async (client) => {
      const messageId = newId();
      await client.query(
        `INSERT INTO accounting.message_attempts (consumer_name, message_id, attempts, last_error_code, first_attempt_at, last_attempt_at)
         VALUES ('schema-test', $1, 1, 'X', now(), now())`,
        [messageId],
      );
      const deleted = await client.query("DELETE FROM accounting.message_attempts WHERE consumer_name = 'schema-test' AND message_id = $1", [
        messageId,
      ]);
      expect(deleted.rowCount).toBe(1);
      await expectDbError(client.query("DELETE FROM accounting.inbox_messages WHERE consumer_name = 'nobody'"), { code: "42501" });
    });
  });
});
