import type { Client } from "pg";

/**
 * Espera, por `pg_locks`, alguma sessão ficar esperando o lock da transação
 * aberta pelo backend `holderPid` (por exemplo, um `INSERT` parado no índice
 * único). Sincroniza por estado observável, nunca por `sleep` (CLAUDE.md).
 */
export async function waitForWaiterOn(
  observer: Client,
  holderPid: number,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      `SELECT 1
         FROM pg_locks waiter
         JOIN pg_locks holder
           ON holder.locktype = 'transactionid'
          AND holder.transactionid = waiter.transactionid
          AND holder.granted
          AND holder.pid = $1
        WHERE waiter.locktype = 'transactionid' AND NOT waiter.granted`,
      [holderPid],
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`ninguém esperou o lock do backend ${holderPid} em 5s`);
}
