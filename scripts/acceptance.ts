import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONSUMER_POLICY } from "../src/modules/wagering/infra/messaging/consumer-policy";

/**
 * `bun run acceptance` (D23.2, D23.6): os exemplos do §9 (`curl` com o
 * header `Authorization`, D10.3) e do §10 (`awslocal sqs send-message` só com
 * `--message-group-id`, D8.1), exatamente como estão escritos, contra o
 * Compose de dev (`bun run infra:up`). O seed criou a wallet do exemplo
 * (D23.1), então a criação literal é `409` e a BET e o §10 funcionam sem
 * edição. Rodar de novo dá o mesmo resultado, com `idempotentReplay: true` e
 * a linha da inbox do §10 já existente.
 *
 * Os comandos rodam como lista de argumentos (Windows e Linux, sem shell);
 * o `-sS -w` só acrescenta o status HTTP à saída do `curl`. Erro de
 * ferramenta (comando ausente, saída de erro, JSON inválido) aborta na hora,
 * com a causa; o polling só repete o que ainda não está pronto.
 */

const REPO_ROOT = join(import.meta.dir, "..");
/** D23.6: endereços do Compose de dev; as variáveis só mudam o host. */
const API = process.env.ACCEPTANCE_API_URL ?? "http://localhost:3000";
const KEYCLOAK = process.env.ACCEPTANCE_KEYCLOAK_URL ?? "http://localhost:8080";
const REALM_FILE = join(REPO_ROOT, "keycloak", "realm-wagering.json");
const READY_TIMEOUT_MS = 180_000;
const QUEUE_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2000;

const WALLET_ID = "0192f291-27dd-7d3f-8071-5f8685deef37";
const SECTION_10_MESSAGE_ID = "msg-123";
const QUEUE_URL = "http://localhost:4566/000000000000/wager-transactions.fifo";
const DLQ_URL = "http://localhost:4566/000000000000/wager-transactions-dlq.fifo";

/**
 * `curl` sem conexão com o servidor: 7 (recusada), 52 (resposta vazia), 56
 * (conexão caiu). Enquanto o Compose sobe, isso é "ainda não pronto".
 */
const CURL_NOT_READY_EXIT_CODES = new Set([7, 52, 56]);

/** §9, "Criar wallet" (L442–447), literal. */
const CREATE_WALLET_BODY = `{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}`;

/** §9, "Submeter transação" (L478–489), literal. */
const BET_BODY = `{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}`;

/** §10, "Mensagem" (L551–567), literal. */
const SECTION_10_BODY = `{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}`;

interface Money {
  amount: string;
  currency: string;
}

class AcceptanceFailure extends Error {}

function check(condition: boolean, what: string, detail?: unknown): void {
  if (!condition) {
    throw new AcceptanceFailure(`${what}${detail === undefined ? "" : `\n  ${JSON.stringify(detail)}`}`);
  }
  console.log(`  ok: ${what}`);
}

/**
 * Mostra o comando como se digitaria num shell POSIX, com o token trocado
 * por `$TOKEN` (o token nunca é impresso, D11.1).
 */
function show(args: string[]): string {
  return args
    .map((arg) => {
      if (arg.startsWith("Authorization: Bearer ")) return '"Authorization: Bearer $TOKEN"';
      if (arg === "\n%{http_code}") return "'\\n%{http_code}'";
      return /[\s"'{}$?&]/.test(arg) ? `'${arg}'` : arg;
    })
    .join(" ");
}

/** Roda o comando; ferramenta ausente vira falha com a causa (ENOENT do spawn). */
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    proc = Bun.spawn(args, { cwd: REPO_ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new AcceptanceFailure(`não consegui rodar ${args[0]}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AcceptanceFailure(
      `${what}: JSON inválido (${error instanceof Error ? error.message : String(error)})\n  ${text.slice(0, 500)}`,
    );
  }
}

interface CurlResult {
  /** `undefined`: sem conexão com o servidor (só com `allowNotReady`). */
  status: number | undefined;
  text: string;
}

/** `curl` com o status HTTP na última linha da saída. */
async function curl(args: string[], options: { quiet?: boolean; allowNotReady?: boolean } = {}): Promise<CurlResult> {
  const full = ["curl", "-sS", "-w", "\n%{http_code}", ...args];
  if (!options.quiet) console.log(`\n$ ${show(full)}`);
  const { code, out, err } = await run(full);
  if (code !== 0) {
    if (options.allowNotReady && CURL_NOT_READY_EXIT_CODES.has(code)) return { status: undefined, text: "" };
    throw new AcceptanceFailure(`curl saiu com ${code}: ${err.trim()}`);
  }
  const cut = out.lastIndexOf("\n");
  const status = Number.parseInt(out.slice(cut + 1), 10);
  if (Number.isNaN(status)) throw new AcceptanceFailure(`curl sem status HTTP na saída: ${out.slice(-200)}`);
  return { status, text: out.slice(0, cut) };
}

/** `curl` de um endpoint que responde JSON: corpo inválido aborta. */
async function curlJson(args: string[], options: { quiet?: boolean } = {}): Promise<{ status: number; body: unknown }> {
  const { status, text } = await curl(args, options);
  if (status === undefined) throw new AcceptanceFailure("curl sem resposta");
  return { status, body: text === "" ? undefined : parseJson(text, `resposta ${status} de ${args.find((a) => a.startsWith("http"))}`) };
}

async function compose(args: string[], options: { quiet?: boolean } = {}): Promise<string> {
  const full = ["docker", "compose", "exec", "-T", ...args];
  if (!options.quiet) console.log(`\n$ ${show(full)}`);
  const { code, out, err } = await run(full);
  if (code !== 0) throw new AcceptanceFailure(`${args.slice(0, 2).join(" ")} saiu com ${code}: ${err.trim()}`);
  if (err.trim() !== "") throw new AcceptanceFailure(`${args.slice(0, 2).join(" ")} escreveu no stderr: ${err.trim()}`);
  return out;
}

function awslocal(args: string[], options: { quiet?: boolean } = {}): Promise<string> {
  return compose(["localstack", "awslocal", ...args], options);
}

/**
 * Espera `probe` dar `true`. Só "ainda não pronto" (`false`) repete: um erro
 * lançado pelo probe aborta na hora, com a causa.
 */
async function waitFor(what: string, timeoutMs: number, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new AcceptanceFailure(`${what}: não aconteceu em ${timeoutMs / 1000} s`);
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

/** Segredos de dev do próprio realm (D23.4: não são segredos reais), como no e2e. */
async function realmSecrets(): Promise<Map<string, string>> {
  const realm = parseJson(await readFile(REALM_FILE, "utf8"), REALM_FILE) as {
    clients: { clientId: string; secret?: string }[];
  };
  return new Map(
    realm.clients.flatMap((c) => (c.secret === undefined ? [] : [[c.clientId, c.secret] as [string, string]])),
  );
}

/** README, "Como pegar o token": `client_credentials` no Keycloak. */
async function token(secrets: Map<string, string>, clientId: string): Promise<string> {
  const secret = secrets.get(clientId);
  if (secret === undefined) throw new AcceptanceFailure(`client ${clientId} sem segredo em ${REALM_FILE}`);
  const { status, body } = await curlJson(
    [
      "-X",
      "POST",
      `${KEYCLOAK}/realms/wagering/protocol/openid-connect/token`,
      "-d",
      "grant_type=client_credentials",
      "-d",
      `client_id=${clientId}`,
      "-d",
      `client_secret=${secret}`,
    ],
    { quiet: true },
  );
  const accessToken = (body as { access_token?: string } | undefined)?.access_token;
  if (status !== 200 || accessToken === undefined) {
    throw new AcceptanceFailure(`token do ${clientId}: status ${status}`);
  }
  console.log(`  ok: token do client ${clientId} (client_credentials no Keycloak)`);
  return accessToken;
}

async function queueCounts(url: string): Promise<number> {
  const out = await awslocal(
    [
      "sqs",
      "get-queue-attributes",
      "--queue-url",
      url,
      "--attribute-names",
      "ApproximateNumberOfMessages",
      "ApproximateNumberOfMessagesNotVisible",
    ],
    { quiet: true },
  );
  const attrs = (parseJson(out, "get-queue-attributes") as { Attributes: Record<string, string> }).Attributes;
  return (
    Number.parseInt(attrs.ApproximateNumberOfMessages ?? "0", 10) +
    Number.parseInt(attrs.ApproximateNumberOfMessagesNotVisible ?? "0", 10)
  );
}

/**
 * Existe a linha da inbox do consumidor de transações para o `msg-123`?
 * Consulta com o papel da app (D7.3), dentro do container do Postgres.
 */
async function inboxHasSection10(): Promise<boolean> {
  const sql =
    "SELECT count(*) FROM inbox_messages " +
    `WHERE consumer_name = '${CONSUMER_POLICY.consumerName}' AND message_id = '${SECTION_10_MESSAGE_ID}'`;
  const out = await compose(
    [
      "postgres",
      "sh",
      "-c",
      `PGPASSWORD="$DB_APP_PASSWORD" psql -h 127.0.0.1 -U wagering_app -d wagering -v ON_ERROR_STOP=1 -tAc "${sql}"`,
    ],
    { quiet: true },
  );
  const count = out.trim();
  if (count !== "0" && count !== "1") throw new AcceptanceFailure(`inbox: saída inesperada do psql: ${count}`);
  return count === "1";
}

async function ledgerEntriesOf(auth: string, transactionId: string): Promise<{ direction: string }[]> {
  const found: { direction: string; transactionId: string }[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor === null ? "?limit=200" : `?limit=200&cursor=${cursor}`;
    const { status, body } = await curlJson([`${API}/wallets/${WALLET_ID}/ledger${query}`, "-H", auth], { quiet: true });
    if (status !== 200) throw new AcceptanceFailure(`ledger: status ${status}`);
    const page = body as { items: { direction: string; transactionId: string }[]; nextCursor: string | null };
    found.push(...page.items.filter((item) => item.transactionId === transactionId));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return found;
}

async function main(): Promise<void> {
  console.log(`== Health (sem token): ${API}`);
  await waitFor(
    "readiness da api",
    READY_TIMEOUT_MS,
    async () => (await curl([`${API}/health/ready`], { quiet: true, allowNotReady: true })).status === 200,
  );
  check((await curl([`${API}/health/live`])).status === 200, "GET /health/live → 200");
  check((await curl([`${API}/health/ready`])).status === 200, "GET /health/ready → 200 (Postgres e SQS)");

  console.log("\n== Tokens");
  const secrets = await realmSecrets();
  const operator = `Authorization: Bearer ${await token(secrets, "operator")}`;
  const provider = `Authorization: Bearer ${await token(secrets, "provider-a")}`;

  console.log("\n== §9 Criar wallet (literal)");
  const created = await curlJson([
    "-X",
    "POST",
    `${API}/wallets`,
    "-H",
    operator,
    "-H",
    "Content-Type: application/json",
    "-d",
    CREATE_WALLET_BODY,
  ]);
  const conflict = created.body as { error?: { code?: string; details?: { walletId?: string } } };
  check(
    created.status === 409 &&
      conflict.error?.code === "WALLET_ALREADY_EXISTS" &&
      conflict.error.details?.walletId === WALLET_ID,
    "409 WALLET_ALREADY_EXISTS com o walletId do exemplo (o seed criou a wallet, D23.1, D6.3)",
    created,
  );

  console.log("\n== §9 Criar wallet com outro playerId");
  const otherPlayer = `acceptance-${Bun.randomUUIDv7()}`;
  const fresh = await curlJson([
    "-X",
    "POST",
    `${API}/wallets`,
    "-H",
    operator,
    "-H",
    "Content-Type: application/json",
    "-d",
    `{ "playerId": "${otherPlayer}", "initialBalance": { "amount": "1000.00", "currency": "BRL" } }`,
  ]);
  const freshWallet = fresh.body as { playerId?: string; balance?: Money; version?: number };
  check(
    fresh.status === 201 &&
      freshWallet.playerId === otherPlayer &&
      freshWallet.balance?.amount === "1000.00" &&
      freshWallet.version === 1,
    "201 com saldo 1000.00 BRL e version 1",
    fresh,
  );

  console.log("\n== §9 Submeter transação (literal)");
  // A transação já existia antes desta rodada? Decide o idempotentReplay esperado.
  const before = await curlJson(
    [`${API}/providers/provider-a/wagering/transactions/transaction-123`, "-H", provider],
    { quiet: true },
  );
  if (before.status !== 200 && before.status !== 404) {
    throw new AcceptanceFailure(`consulta da transaction-123 antes da BET: status ${before.status}`);
  }
  const existedBefore = before.status === 200;
  console.log(`  transaction-123 ${existedBefore ? "já existia (rodada repetida)" : "ainda não existia"}`);
  const bet = await curlJson([
    "-X",
    "POST",
    `${API}/wagering/transactions`,
    "-H",
    provider,
    "-H",
    "Idempotency-Key: provider-a:transaction-123",
    "-H",
    "Content-Type: application/json",
    "-d",
    BET_BODY,
  ]);
  const betBody = bet.body as { transactionId?: string; status?: string; balance?: Money; idempotentReplay?: boolean };
  check(
    bet.status === 200 &&
      betBody.status === "PROCESSED" &&
      betBody.balance?.amount === "975.00" &&
      betBody.balance.currency === "BRL" &&
      betBody.idempotentReplay === existedBefore,
    `200 PROCESSED, saldo 975.00 BRL, idempotentReplay: ${existedBefore} (D3.3)`,
    bet,
  );
  const transactionId = betBody.transactionId ?? "";

  console.log("\n== §10 SendMessage (literal, só com --message-group-id)");
  const inboxBefore = await inboxHasSection10();
  const dlqBefore = await queueCounts(DLQ_URL);
  await awslocal([
    "sqs",
    "send-message",
    "--queue-url",
    QUEUE_URL,
    "--message-group-id",
    WALLET_ID,
    "--message-body",
    SECTION_10_BODY,
  ]);
  if (inboxBefore) {
    console.log(
      `  a inbox já tinha ${SECTION_10_MESSAGE_ID} antes do envio (rodada repetida ou deduplicação do SQS): ` +
        "esta rodada não prova um novo processamento pelo consumidor",
    );
  } else {
    await waitFor(`a linha da inbox do ${SECTION_10_MESSAGE_ID}`, QUEUE_TIMEOUT_MS, inboxHasSection10);
    console.log(`  ok: o consumidor processou ${SECTION_10_MESSAGE_ID} (linha da inbox gravada, D3.7)`);
  }
  await waitFor("o consumidor dar ack na mensagem do §10", QUEUE_TIMEOUT_MS, async () => (await queueCounts(QUEUE_URL)) === 0);
  console.log("  ok: fila wager-transactions.fifo vazia (ack depois do commit)");
  check((await queueCounts(DLQ_URL)) === dlqBefore, "nada novo na DLQ");
  const entries = await ledgerEntriesOf(operator, transactionId);
  check(
    entries.length === 1 && entries[0]?.direction === "DEBIT",
    "um único débito da transaction-123 no ledger (o §10 é replay da BET, D3.3)",
    entries,
  );

  console.log("\n== §9 Consultas");
  const wallet = await curlJson([`${API}/wallets/${WALLET_ID}`, "-H", operator]);
  const walletBody = wallet.body as { balance?: Money };
  check(wallet.status === 200 && walletBody.balance?.amount === "975.00", "GET /wallets/:walletId → 200, saldo 975.00", wallet);
  const ledger = await curlJson([`${API}/wallets/${WALLET_ID}/ledger?limit=50`, "-H", operator]);
  check(ledger.status === 200, "GET /wallets/:walletId/ledger → 200", ledger.status);
  const byId = await curlJson([`${API}/wagering/transactions/${transactionId}`, "-H", provider]);
  check(
    byId.status === 200 && (byId.body as { status?: string }).status === "PROCESSED",
    "GET /wagering/transactions/:transactionId → 200 PROCESSED",
    byId,
  );
  const byExternal = await curlJson([`${API}/providers/provider-a/wagering/transactions/transaction-123`, "-H", provider]);
  check(
    byExternal.status === 200 && (byExternal.body as { transactionId?: string }).transactionId === transactionId,
    "GET /providers/:providerId/wagering/transactions/:externalTransactionId → 200, mesma transação",
    byExternal,
  );

  console.log("\n== §9 Reconciliação");
  const reconciliation = await curlJson(["-X", "POST", `${API}/wallets/${WALLET_ID}/reconciliation`, "-H", operator]);
  const recon = reconciliation.body as { consistent?: boolean; difference?: Money; storedBalance?: Money };
  check(
    reconciliation.status === 200 &&
      recon.consistent === true &&
      recon.difference?.amount === "0.00" &&
      recon.storedBalance?.amount === "975.00",
    "200 consistent: true, difference 0.00, storedBalance 975.00",
    reconciliation,
  );

  console.log("\nAceitação: tudo ok.");
}

main().catch((error) => {
  console.error(`\nAceitação FALHOU: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
