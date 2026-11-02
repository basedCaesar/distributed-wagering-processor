import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const REALM_FILE = join(import.meta.dir, "..", "..", "keycloak", "realm-wagering.json");

interface ProtocolMapper {
  protocolMapper: string;
  config: Record<string, string>;
}

interface RealmClient {
  clientId: string;
  publicClient?: boolean;
  serviceAccountsEnabled?: boolean;
  standardFlowEnabled?: boolean;
  implicitFlowEnabled?: boolean;
  directAccessGrantsEnabled?: boolean;
  protocolMappers?: ProtocolMapper[];
}

interface RealmUser {
  serviceAccountClientId?: string;
  realmRoles?: string[];
}

interface Realm {
  realm: string;
  roles?: { realm?: { name: string }[] };
  clients?: RealmClient[];
  users?: RealmUser[];
}

const PROVIDERS = ["provider-a", "provider-b"];

let realm: Realm;

beforeAll(async () => {
  realm = JSON.parse(await readFile(REALM_FILE, "utf8")) as Realm;
});

function client(clientId: string): RealmClient {
  const found = realm.clients?.find((c) => c.clientId === clientId);
  if (found === undefined) throw new Error(`client ${clientId} não está no realm`);
  return found;
}

function serviceAccountRoles(clientId: string): string[] {
  return realm.users?.find((u) => u.serviceAccountClientId === clientId)?.realmRoles ?? [];
}

function mappers(clientId: string, type: string): ProtocolMapper[] {
  return (client(clientId).protocolMappers ?? []).filter((m) => m.protocolMapper === type);
}

describe("D23.4: realm wagering do Keycloak", () => {
  it("D23.4 D16.1: realm wagering com os papéis de realm provider e operator", () => {
    expect(realm.realm).toBe("wagering");
    const roles = (realm.roles?.realm ?? []).map((r) => r.name);
    expect(roles).toContain("provider");
    expect(roles).toContain("operator");
  });

  it("D23.4 D16.1: provider-a e provider-b têm papel provider e mapper provider_id = clientId no access token", () => {
    for (const id of PROVIDERS) {
      expect({ id, roles: serviceAccountRoles(id).filter((r) => r === "provider" || r === "operator") }).toEqual({
        id,
        roles: ["provider"],
      });
      const claims = mappers(id, "oidc-hardcoded-claim-mapper").filter((m) => m.config["claim.name"] === "provider_id");
      expect(claims.map((m) => ({ value: m.config["claim.value"], access: m.config["access.token.claim"] }))).toEqual([
        { value: id, access: "true" },
      ]);
    }
  });

  it("D23.4 D10.2: operator tem papel operator e nenhum provider_id", () => {
    expect(serviceAccountRoles("operator").filter((r) => r === "provider" || r === "operator")).toEqual(["operator"]);
    const claims = mappers("operator", "oidc-hardcoded-claim-mapper").filter(
      (m) => m.config["claim.name"] === "provider_id",
    );
    expect(claims).toEqual([]);
  });

  it("D23.4 D10.1: todo client tem audiência wagering-api e só client_credentials (confidencial, sem fluxo de usuário)", () => {
    for (const id of [...PROVIDERS, "operator"]) {
      const c = client(id);
      expect({
        id,
        publicClient: c.publicClient ?? false,
        serviceAccounts: c.serviceAccountsEnabled ?? false,
        standardFlow: c.standardFlowEnabled ?? true,
        implicitFlow: c.implicitFlowEnabled ?? false,
        directAccessGrants: c.directAccessGrantsEnabled ?? true,
      }).toEqual({
        id,
        publicClient: false,
        serviceAccounts: true,
        standardFlow: false,
        implicitFlow: false,
        directAccessGrants: false,
      });
      const audiences = mappers(id, "oidc-audience-mapper").map((m) => ({
        audience: m.config["included.custom.audience"],
        access: m.config["access.token.claim"],
      }));
      expect({ id, audiences }).toEqual({ id, audiences: [{ audience: "wagering-api", access: "true" }] });
    }
  });
});
