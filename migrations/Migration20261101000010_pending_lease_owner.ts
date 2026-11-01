import { Migration } from "@mikro-orm/migrations";

/**
 * Dono do lease de uma pendente (D18.10). O claim grava o token do worker;
 * a tentativa, depois de travar a wallet e a linha, só segue se o token
 * ainda é o dela. Sem isso, um lease vencido com o item em processamento
 * deixava dois workers tentarem a mesma pendente. Coluna de controle, fora
 * da entidade (D4.5).
 */
export class Migration20261101000010_pending_lease_owner extends Migration {
  override name = "Migration20261101000010_pending_lease_owner";

  override up(): void {
    this.addSql("ALTER TABLE wager_transactions ADD COLUMN locked_by uuid;");
  }

  override down(): void {
    this.addSql("ALTER TABLE wager_transactions DROP COLUMN locked_by;");
  }
}
