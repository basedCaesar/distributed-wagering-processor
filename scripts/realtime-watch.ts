/**
 * `bun run realtime:watch <walletId>` (D28.13): segue uma wallet pelo
 * WebSocket e imprime uma linha por evento, aplicando o contrato do cliente
 * da D28.8: o WebSocket é notificação; a verdade é o `GET /wallets/:id`.
 *
 *   1. pega um token `client_credentials` no Keycloak (o do README);
 *   2. conecta em `/realtime`, manda `auth` e `follow`;
 *   3. faz o GET da wallet e parte da `version` dele;
 *   4. aplica os eventos com versão maior; num furo, refaz o GET;
 *   5. reconecta sozinho (token vencido, instância parando, queda).
 *
 * Opções: `--url` (ws://localhost:3000/realtime), `--api`
 * (http://localhost:3000), `--keycloak` (http://localhost:8080), `--client`
 * (operator; o segredo de desenvolvimento é `<client>-dev-secret`), e, para
 * o CI, `--exit-after <n>` (sai com 0 depois de n eventos aplicados) e
 * `--timeout <s>` (sai com 1 se não chegar lá). O token nunca é impresso.
 */
import { parseArgs } from "node:util";
import { CloseCode } from "../src/modules/realtime/domain/close-codes";
import { WalletView } from "../src/modules/realtime/domain/wallet-view";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECONNECT_MS = 1000;
/** Fechamentos em que reconectar não resolve (D28.2). */
const FATAL_CLOSES = new Set<number>([CloseCode.ProtocolViolation]);

interface Money {
  amount: string;
  currency: string;
}

interface EventMessage {
  type: "event";
  eventId: string;
  eventType: string;
  walletId: string;
  walletVersion: number | null;
  data: Record<string, unknown>;
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    url: { type: "string", default: "ws://localhost:3000/realtime" },
    api: { type: "string", default: "http://localhost:3000" },
    keycloak: { type: "string", default: "http://localhost:8080" },
    client: { type: "string", default: "operator" },
    "exit-after": { type: "string" },
    timeout: { type: "string" },
  },
});

const walletId = positionals[0];
if (walletId === undefined || !UUID.test(walletId)) {
  console.error("uso: bun run realtime:watch <walletId> [--url ws://…] [--api http://…] [--client operator]");
  process.exit(2);
}
const exitAfter = values["exit-after"] === undefined ? undefined : Number.parseInt(values["exit-after"], 10);
const timeoutSeconds = values.timeout === undefined ? undefined : Number.parseInt(values.timeout, 10);

const money = (value: unknown): string => {
  const m = value as Money | undefined;
  return m === undefined ? "" : `${m.amount} ${m.currency}`;
};
const time = (): string => new Date().toISOString().slice(11, 23);
const log = (line: string): void => console.log(`${time()}  ${line}`);

async function fetchToken(): Promise<string> {
  const client = values.client;
  const response = await fetch(`${values.keycloak}/realms/wagering/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: client, client_secret: `${client}-dev-secret` }),
  });
  if (!response.ok) throw new Error(`token do client ${client}: status ${response.status}`);
  const { access_token: token } = (await response.json()) as { access_token?: string };
  if (token === undefined) throw new Error(`token do client ${client}: resposta sem access_token`);
  return token;
}

/** O GET da wallet (D28.8): a verdade de onde a visão parte. */
async function fetchWallet(token: string): Promise<{ version: number; balance: Money }> {
  const response = await fetch(`${values.api}/wallets/${walletId}`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 404) throw new Error(`wallet ${walletId} não existe (404)`);
  if (!response.ok) throw new Error(`GET /wallets/${walletId}: status ${response.status}`);
  return (await response.json()) as { version: number; balance: Money };
}

function describe(event: EventMessage): string {
  const version = event.walletVersion === null ? "  " : `v${event.walletVersion}`;
  const d = event.data;
  switch (event.eventType) {
    case "WalletBalanceChanged":
      return `${version}  saldo  ${String(d.direction).padEnd(6)} ${money(d.money).padStart(14)}  →  ${money(d.balanceAfter)}`;
    case "WalletOpened":
      return `${version}  wallet aberta com ${money(d.initialBalance)}`;
    default:
      return `${version}  transação  ${String(d.kind).padEnd(8)} ${String(d.status).padEnd(17)} ${money(d.money)} ${d.externalTransactionId ?? ""}${d.failureCode ? ` (${d.failureCode})` : ""}`;
  }
}

let applied = 0;

function countApplied(): void {
  applied++;
  if (exitAfter !== undefined && applied >= exitAfter) {
    log(`${applied} evento(s) aplicado(s): saindo (--exit-after)`);
    process.exit(0);
  }
}

/** Uma conexão: resolve com o código de fechamento. */
async function session(): Promise<number> {
  const token = await fetchToken();
  const socket = new WebSocket(values.url);
  let view: WalletView | undefined;
  const buffer: EventMessage[] = [];

  const resync = async (): Promise<void> => {
    const wallet = await fetchWallet(token);
    if (view === undefined) view = new WalletView(wallet.version);
    else view.resync(wallet.version);
    log(`GET /wallets: v${wallet.version}, saldo ${money(wallet.balance)} (a verdade; o WebSocket só notifica)`);
  };

  const handle = async (event: EventMessage): Promise<void> => {
    if (view === undefined) {
      buffer.push(event);
      return;
    }
    const decision = view.accept(event);
    if (decision === "apply") {
      log(describe(event));
      countApplied();
    } else if (decision === "resync") {
      log(`furo de versão (chegou v${event.walletVersion}, tinha v${view.version}): refazendo o GET`);
      await resync();
    }
  };

  let queue = Promise.resolve();
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", token })));
  socket.addEventListener("message", (message) => {
    const parsed = JSON.parse(String(message.data)) as { type: string; [key: string]: unknown };
    queue = queue.then(async () => {
      try {
        if (parsed.type === "authenticated") {
          socket.send(JSON.stringify({ type: "follow", walletId }));
        } else if (parsed.type === "followed") {
          log(`seguindo a wallet ${walletId} em ${values.url}`);
          await resync();
          for (const event of buffer.splice(0)) await handle(event);
        } else if (parsed.type === "event") {
          await handle(parsed as unknown as EventMessage);
        } else if (parsed.type === "error") {
          log(`erro do servidor: ${String(parsed.code)}`);
        }
      } catch (error) {
        // GET da wallet falhou: sem a verdade, a visão não vale; reconecta do zero.
        log(`falhou: ${error instanceof Error ? error.message : String(error)}`);
        socket.close();
      }
    });
  });
  return new Promise((resolve) => {
    socket.addEventListener("close", (event) => resolve(event.code), { once: true });
  });
}

if (timeoutSeconds !== undefined) {
  setTimeout(() => {
    console.error(`${time()}  nenhum evento suficiente em ${timeoutSeconds} s (--timeout)`);
    process.exit(1);
  }, timeoutSeconds * 1000);
}

for (;;) {
  let code: number;
  try {
    code = await session();
  } catch (error) {
    log(`falhou: ${error instanceof Error ? error.message : String(error)}; tentando de novo`);
    await Bun.sleep(RECONNECT_MS);
    continue;
  }
  if (FATAL_CLOSES.has(code)) {
    console.error(`${time()}  conexão fechada com ${code}: reconectar não resolve`);
    process.exit(1);
  }
  log(`conexão fechada (${code}); reconectando com um token novo`);
  await Bun.sleep(RECONNECT_MS);
}
