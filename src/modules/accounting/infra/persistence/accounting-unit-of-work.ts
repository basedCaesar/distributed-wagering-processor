import { type EntityManager, IsolationLevel, type MikroORM } from "@mikro-orm/postgresql";
import type {
  AccountingIdGenerator,
  AccountingScope,
  AccountingUnitOfWork,
  EventHalf,
  EventHalfType,
  InboxRegistration,
} from "../../application/ports";
import { Amount } from "../../domain/amount";
import { ACCOUNT_NATURE, AccountCode } from "../../domain/chart-of-accounts";
import type { JournalEntry, LineDirection } from "../../domain/journal-entry";

/** Inbox (D19.4, D27.4): a linha só fica se o efeito commitar; a duplicata simultânea espera no índice único. */
const INBOX_INSERT_SQL = `
  INSERT INTO accounting.inbox_messages (consumer_name, message_id, payload_hash, processed_at)
  VALUES (?, ?, ?, now())
  ON CONFLICT (consumer_name, message_id) DO NOTHING
  RETURNING message_id`;

const INBOX_HASH_SQL = `
  SELECT payload_hash FROM accounting.inbox_messages WHERE consumer_name = ? AND message_id = ?`;

const PLAYER_ACCOUNT_INSERT_SQL = `
  INSERT INTO accounting.accounts (id, code, nature, currency, wallet_id)
  VALUES (?, 'PLAYER_WALLET', 'LIABILITY', ?, ?)
  ON CONFLICT (wallet_id) DO NOTHING`;

/** Lock 2 da ordem do accounting (D27.4): a linha da conta da wallet. */
const PLAYER_ACCOUNT_LOCK_SQL = `
  SELECT id, currency FROM accounting.accounts WHERE wallet_id = ? FOR UPDATE`;

const HOUSE_ACCOUNT_INSERT_SQL = `
  INSERT INTO accounting.accounts (id, code, nature, currency, wallet_id)
  VALUES (?, ?, ?, ?, NULL)
  ON CONFLICT (code, currency) WHERE wallet_id IS NULL DO NOTHING`;

const HOUSE_ACCOUNT_SQL = `
  SELECT id FROM accounting.accounts WHERE code = ? AND currency = ? AND wallet_id IS NULL`;

const FIND_HALF_SQL = `
  SELECT event_id, event_type, transaction_id, wallet_id, wallet_version, currency, amount::text AS amount,
         kind, direction, balance_before::text AS balance_before, balance_after::text AS balance_after,
         to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at
    FROM accounting.received_events WHERE transaction_id = ? AND event_type = ?`;

const INSERT_HALF_SQL = `
  INSERT INTO accounting.received_events
    (event_id, event_type, transaction_id, wallet_id, wallet_version, currency, amount,
     kind, direction, balance_before, balance_after, occurred_at, received_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())`;

const INSERT_ENTRY_SQL = `
  INSERT INTO accounting.journal_entries
    (id, transaction_id, wallet_id, wallet_version, kind, currency, balance_event_id, processed_event_id, occurred_at, posted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now())`;

const INSERT_LINE_SQL = `
  INSERT INTO accounting.journal_lines (entry_id, line_no, account_id, direction, amount, currency)
  VALUES (?, ?, ?, ?, ?, ?)`;

interface HalfRow {
  event_id: string;
  event_type: EventHalfType;
  transaction_id: string;
  wallet_id: string;
  wallet_version: number;
  currency: string;
  amount: string;
  kind: string | null;
  direction: LineDirection | null;
  balance_before: string | null;
  balance_after: string;
  occurred_at: string;
}

function halfFrom(row: HalfRow): EventHalf {
  const money = (amount: string) => Amount.parse({ amount, currency: row.currency });
  const base = {
    eventId: row.event_id,
    transactionId: row.transaction_id,
    walletId: row.wallet_id,
    walletVersion: row.wallet_version,
    amount: money(row.amount),
    balanceAfter: money(row.balance_after),
    occurredAt: new Date(row.occurred_at),
  };
  if (row.event_type === "WalletBalanceChanged") {
    return {
      ...base,
      type: "WalletBalanceChanged",
      direction: row.direction as LineDirection,
      balanceBefore: money(row.balance_before as string),
    };
  }
  return { ...base, type: "WagerTransactionProcessed", kind: row.kind as string };
}

function scopeFor(em: EntityManager, ids: AccountingIdGenerator): AccountingScope {
  let playerAccountId: string | undefined;

  async function houseAccountId(code: AccountCode, currency: string): Promise<string> {
    await em.execute(HOUSE_ACCOUNT_INSERT_SQL, [ids.next(), code, ACCOUNT_NATURE[code], currency]);
    const [row] = await em.execute<{ id: string }[]>(HOUSE_ACCOUNT_SQL, [code, currency]);
    if (!row) throw new Error("conta da casa sumiu depois do upsert");
    return row.id;
  }

  return {
    async registerInbox(entry): Promise<InboxRegistration> {
      const inserted = await em.execute<{ message_id: string }[]>(INBOX_INSERT_SQL, [
        entry.consumerName,
        entry.messageId,
        entry.hash,
      ]);
      if (inserted.length > 0) return "new";
      const [row] = await em.execute<{ payload_hash: string }[]>(INBOX_HASH_SQL, [entry.consumerName, entry.messageId]);
      if (!row) throw new Error("linha da inbox do accounting sumiu depois do conflito");
      return row.payload_hash === entry.hash ? "duplicate" : "conflict";
    },

    async lockPlayerAccount(walletId, currency) {
      await em.execute(PLAYER_ACCOUNT_INSERT_SQL, [ids.next(), currency, walletId]);
      const [row] = await em.execute<{ id: string; currency: string }[]>(PLAYER_ACCOUNT_LOCK_SQL, [walletId]);
      if (!row) throw new Error("conta da wallet sumiu depois do upsert");
      playerAccountId = row.id;
      return { currency: row.currency };
    },

    async findHalf(transactionId, type) {
      const [row] = await em.execute<HalfRow[]>(FIND_HALF_SQL, [transactionId, type]);
      return row === undefined ? undefined : halfFrom(row);
    },

    async insertHalf(half) {
      await em.execute(INSERT_HALF_SQL, [
        half.eventId,
        half.type,
        half.transactionId,
        half.walletId,
        half.walletVersion,
        half.amount.currency,
        half.amount.toString(),
        half.type === "WagerTransactionProcessed" ? half.kind : null,
        half.type === "WalletBalanceChanged" ? half.direction : null,
        half.type === "WalletBalanceChanged" ? half.balanceBefore.toString() : null,
        half.balanceAfter.toString(),
        half.occurredAt,
      ]);
    },

    async postEntry(entry: JournalEntry, sources) {
      if (playerAccountId === undefined) throw new Error("lançamento sem o lock da conta da wallet");
      await em.execute(INSERT_ENTRY_SQL, [
        entry.id,
        entry.transactionId,
        entry.walletId,
        entry.walletVersion,
        entry.kind,
        entry.currency,
        sources.balanceEventId,
        sources.processedEventId,
        sources.occurredAt,
      ]);
      for (const line of entry.lines) {
        const accountId =
          line.account === AccountCode.PlayerWallet ? playerAccountId : await houseAccountId(line.account, entry.currency);
        await em.execute(INSERT_LINE_SQL, [
          entry.id,
          line.lineNo,
          accountId,
          line.direction,
          line.amount.toString(),
          line.amount.currency,
        ]);
      }
    },
  };
}

/**
 * Uma transação `READ COMMITTED` por chamada, num `EntityManager` novo
 * (como o núcleo, D7.1), com SQL direto: o accounting não tem entidades
 * do ORM. Em `READ COMMITTED`, depois de esperar o lock da conta, as
 * leituras seguintes veem o que a outra transação commitou (D27.4). Os
 * prazos da sessão (D5) valem: lock esperando > 2 s vira transitório.
 */
export class MikroOrmAccountingUnitOfWork implements AccountingUnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly ids: AccountingIdGenerator = { next: () => Bun.randomUUIDv7() },
  ) {}

  run<T>(work: (scope: AccountingScope) => Promise<T>): Promise<T> {
    return this.orm.em
      .fork()
      .transactional((em) => work(scopeFor(em, this.ids)), { isolationLevel: IsolationLevel.READ_COMMITTED });
  }
}
