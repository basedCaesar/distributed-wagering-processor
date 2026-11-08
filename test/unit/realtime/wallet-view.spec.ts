import { describe, expect, it } from "bun:test";
import { WalletView } from "../../../src/modules/realtime/domain/wallet-view";

const balance = (walletVersion: number, eventId = `wbc-${walletVersion}`) => ({
  eventId,
  eventType: "WalletBalanceChanged",
  walletVersion,
});
const processed = (walletVersion: number | null, eventId: string) => ({
  eventId,
  eventType: "WagerTransactionProcessed",
  walletVersion,
});

describe("D28.8: contrato do cliente (GET + walletVersion)", () => {
  it("D28.8: aplica a versão seguinte e descarta as que o snapshot já contém", () => {
    const view = new WalletView(3);

    expect(view.accept(balance(2))).toBe("skip");
    expect(view.accept(balance(3))).toBe("skip");
    expect(view.accept(balance(4))).toBe("apply");
    expect(view.version).toBe(4);
    expect(view.accept(balance(4, "outro-id"))).toBe("skip");
  });

  it("D28.8: furo de versão → resync (refazer o GET)", () => {
    const view = new WalletView(3);

    expect(view.accept(balance(5))).toBe("resync");
    expect(view.version).toBe(3);
    view.resync(5);
    expect(view.accept(balance(6))).toBe("apply");
  });

  it("D28.7 D28.8: duplicata pelo eventId é descartada", () => {
    const view = new WalletView(1);

    expect(view.accept(processed(null, "e1"))).toBe("apply");
    expect(view.accept(processed(null, "e1"))).toBe("skip");
  });

  it("D28.8: evento de transação com a mesma walletVersion do saldo é aplicado (os dois saem no mesmo commit)", () => {
    const view = new WalletView(1);

    expect(view.accept(balance(2))).toBe("apply");
    expect(view.accept(processed(2, "p2"))).toBe("apply");
  });

  it("D28.8: evento de transação já contido no snapshot é descartado", () => {
    const view = new WalletView(5);

    expect(view.accept(processed(4, "p4"))).toBe("skip");
    expect(view.accept(processed(5, "p5"))).toBe("skip");
  });
});
