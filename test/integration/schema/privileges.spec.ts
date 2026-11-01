import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "pg";
import { connect, expectDbError } from "../../support/db";
import { seedWallet } from "../../support/db-seed";

describe("S2 D7.3: privilégios do papel da aplicação", () => {
  let app: Client;

  beforeAll(async () => {
    app = await connect("app");
  });

  afterAll(async () => {
    await app.end();
  });

  it("D7.3: a app conecta com um papel que não é superusuário nem dono das tabelas", async () => {
    const { rows } = await app.query(`
      SELECT r.rolsuper AS super,
             (SELECT count(*)::int FROM pg_tables
               WHERE schemaname = 'public' AND tableowner = current_user) AS owned
        FROM pg_roles r WHERE r.rolname = current_user`);

    expect(rows[0]).toEqual({ super: false, owned: 0 });
  });

  it("D7.3: a app não cria tabela", async () => {
    await expectDbError(app.query("CREATE TABLE intruder (id int)"), {
      code: "42501",
    });
  });

  it("D7.3: a app não dropa nem altera tabela", async () => {
    await expectDbError(app.query("DROP TABLE wallet_ledger_entries"), {
      code: "42501",
    });
    await expectDbError(
      app.query(
        "ALTER TABLE wallets DROP CONSTRAINT wallets_balance_non_negative_ck",
      ),
      { code: "42501" },
    );
  });

  it("D7.3: a app não desliga triggers", async () => {
    await expectDbError(
      app.query("ALTER TABLE wallet_ledger_entries DISABLE TRIGGER ALL"),
      { code: "42501" },
    );
  });

  it("D7.3: a app não apaga wallets nem transações", async () => {
    const wallet = await seedWallet(app);

    await expectDbError(
      app.query("DELETE FROM wallets WHERE id = $1", [wallet.id]),
      { code: "42501" },
    );
    await expectDbError(
      app.query("DELETE FROM wager_transactions WHERE wallet_id = $1", [
        wallet.id,
      ]),
      { code: "42501" },
    );
  });

  it("D7.3 D19.11: o único DELETE do papel da app é em message_attempts; TRUNCATE em nenhuma tabela", async () => {
    const { rows } = await app.query<{ table_name: string; privilege_type: string }>(`
      SELECT table_name, privilege_type
        FROM information_schema.role_table_grants
       WHERE grantee = current_user
         AND table_schema = 'public'
         AND privilege_type IN ('DELETE', 'TRUNCATE')
       ORDER BY table_name, privilege_type`);

    expect(rows).toEqual([{ table_name: "message_attempts", privilege_type: "DELETE" }]);
  });

  it("R-06-22 D7.3: a app não muda player_id nem moeda de uma wallet", async () => {
    const wallet = await seedWallet(app);

    await expectDbError(
      app.query("UPDATE wallets SET currency = 'USD' WHERE id = $1", [
        wallet.id,
      ]),
      { code: "42501" },
    );
    await expectDbError(
      app.query("UPDATE wallets SET player_id = 'someone-else' WHERE id = $1", [
        wallet.id,
      ]),
      { code: "42501" },
    );
  });

  it("D7.3: só as migrations usam o papel dono, então a app não lê a tabela de controle delas", async () => {
    await expectDbError(app.query("SELECT * FROM mikro_orm_migrations"), {
      code: "42501",
    });
  });
});
