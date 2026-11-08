import { describe, expect, it } from "bun:test";
import {
  duplicateScheduleS,
  duplicateSendAtMs,
  hotWalletBalance,
  LOAD_PLAN,
  parseLoadArgs,
  type ScenarioId,
  stepSeconds,
  tokenCovers,
} from "../../../load/lib/plan";

/**
 * D26.2: o experimento é fixo no código (cenários, degraus, durações), e só o
 * número de rodadas muda pela linha de comando (padrão 3; `--rounds 1` para
 * iterar no desenvolvimento).
 */

describe("D26.2: argumentos do test:load", () => {
  const ALL: ScenarioId[] = ["A", "B", "C", "D"];

  it("D26.2: sem argumento → 3 rodadas, todos os cenários", () => {
    expect(parseLoadArgs([])).toEqual({ rounds: 3, scenarios: ALL });
  });

  it("D26.2: --rounds N e --rounds=N", () => {
    expect(parseLoadArgs(["--rounds", "1"])).toEqual({ rounds: 1, scenarios: ALL });
    expect(parseLoadArgs(["--rounds=2"])).toEqual({ rounds: 2, scenarios: ALL });
  });

  it("D26.2: rodadas fora de 1..10, sem valor ou argumento desconhecido → erro", () => {
    for (const argv of [["--rounds", "0"], ["--rounds", "11"], ["--rounds", "1.5"], ["--rounds"], ["--rounds", "x"], ["--fast"]]) {
      expect(() => parseLoadArgs(argv)).toThrow();
    }
  });

  it("D26.12: --scenarios escolhe os cenários, sempre na ordem do plano e sem repetição", () => {
    expect(parseLoadArgs(["--scenarios", "B"])).toEqual({ rounds: 3, scenarios: ["B"] });
    expect(parseLoadArgs(["--scenarios=D,A,A", "--rounds", "1"])).toEqual({ rounds: 1, scenarios: ["A", "D"] });
  });

  it("D26.12: --scenarios vazio, sem valor ou com cenário desconhecido → erro", () => {
    for (const argv of [["--scenarios"], ["--scenarios", ""], ["--scenarios", "E"], ["--scenarios", "A,,B"], ["--scenarios", "a"]]) {
      expect(() => parseLoadArgs(argv)).toThrow();
    }
  });
});

describe("D26.2: plano dos cenários", () => {
  it("D26.2: A (throughput) e B (hot wallet) em degraus crescentes; C e D com tamanhos fixos", () => {
    const rates = (steps: readonly { rate: number }[]) => steps.map((s) => s.rate);
    expect(rates(LOAD_PLAN.throughput.steps)).toEqual([50, 100, 200, 400]);
    expect(rates(LOAD_PLAN.hotWallet.steps)).toEqual([10, 25, 50, 100]);
    expect(LOAD_PLAN.throughput.wallets).toBe(200);
    expect(LOAD_PLAN.duplicates).toMatchObject({ keys: 50, copies: 20 });
    expect(LOAD_PLAN.queue).toMatchObject({ wallets: 100, messages: 2000 });
    // D26.2: 30 s por degrau (aprovado em 08/11/2026; com 60 s, as 3 rodadas levavam ~2h10).
    for (const s of [...LOAD_PLAN.throughput.steps, ...LOAD_PLAN.hotWallet.steps]) {
      expect(s.durationS).toBe(30);
    }
  });

  it("D26.2: a hot wallet de cada degrau cobre 70% das BETs previstas, em reais inteiros", () => {
    // 10 req/s × 60 s = 600 BETs de 1.00 → 420.00.
    expect(hotWalletBalance({ rate: 10, durationS: 60 }, "1.00")).toBe("420.00");
    expect(hotWalletBalance({ rate: 25, durationS: 60 }, "1.00")).toBe("1050.00");
  });

  it("D26.2: no C, as cópias de cada key partem no mesmo instante absoluto, um intervalo fixo por key", () => {
    const { leadS, slotS, keys } = LOAD_PLAN.duplicates;
    const startAtMs = 1_000_000;
    expect(duplicateSendAtMs(startAtMs, 0)).toBe(startAtMs);
    expect(duplicateSendAtMs(startAtMs, 3)).toBe(startAtMs + 3 * slotS * 1000);
    // O agendamento inteiro cabe no prazo do cenário, com folga para a última key.
    expect(duplicateScheduleS()).toBe(leadS + keys * slotS);
    expect(LOAD_PLAN.duplicates.maxDurationS).toBeGreaterThan(duplicateScheduleS());
  });

  it("D26.3: o token do passo precisa valer mais que o passo inteiro, com 60 s de folga", () => {
    const step = { rate: 50, durationS: 60 };
    expect(stepSeconds(step)).toBeGreaterThanOrEqual(60);
    expect(tokenCovers(300, stepSeconds(step))).toBe(true);
    expect(tokenCovers(stepSeconds(step) + 59, stepSeconds(step))).toBe(false);
  });
});
