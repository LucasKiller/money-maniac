import { describe, expect, it } from "vitest";
import {
  applyAutonomyProfile,
  applyResearchProfile,
  OPERATOR_ALLOWED_TOOLS,
  operatorDailyActionLimitReached,
  RESEARCH_ALLOWED_TOOLS,
  resolveAutonomyLimits,
} from "../security/autonomy-profile.js";
import { createTestConfig } from "./mocks.js";

describe("research autonomy profile", () => {
  it("applies bounded defaults and disables unsafe capabilities", () => {
    const limits = resolveAutonomyLimits({ AUTOMATON_AUTONOMY_PROFILE: "research" });
    const config = applyResearchProfile(createTestConfig({
      maxChildren: 5,
      allowUnsafeHostExecution: true,
      allowUnsafeLocalWorkers: true,
      enableAutonomousTopup: true,
      enableFinancialOperations: true,
      socialRelayUrl: "https://social.example.com",
    }), limits);

    expect(limits).toMatchObject({
      dailyInferenceBudgetCents: 25,
      hourlyInferenceBudgetCents: 5,
      perCallCeilingCents: 2,
      maxTurnsPerCycle: 3,
      maxTurnsPerDay: 12,
      minTurnIntervalMs: 900_000,
    });
    expect(config).toMatchObject({
      inferenceModel: "gpt-5-mini",
      maxChildren: 0,
      allowUnsafeHostExecution: false,
      allowUnsafeLocalWorkers: false,
      enableAutonomousTopup: false,
      enableFinancialOperations: false,
      socialRelayUrl: undefined,
    });
    expect(config.modelStrategy?.dailyBudgetCents).toBe(25);
    expect(config.modelStrategy?.inferenceModel).toBe("gpt-5-mini");
  });

  it("rejects invalid limits and never allowlists dangerous tools", () => {
    expect(() => resolveAutonomyLimits({
      AUTOMATON_AUTONOMY_PROFILE: "research",
      AUTOMATON_MAX_TURNS_PER_DAY: "not-a-number",
    })).toThrow("AUTOMATON_MAX_TURNS_PER_DAY");

    for (const tool of ["exec", "write_file", "spawn_child", "send_message", "x402_fetch", "transfer_credits", "edit_own_file"]) {
      expect(RESEARCH_ALLOWED_TOOLS.has(tool)).toBe(false);
    }
  });
});

describe("operator autonomy profile", () => {
  it("enables only treasury-gated finance with conservative policy", () => {
    const previousMode = process.env.AUTOMATON_FINANCIAL_MODE;
    process.env.AUTOMATON_FINANCIAL_MODE = "treasury-gated";
    try {
      const limits = resolveAutonomyLimits({ AUTOMATON_AUTONOMY_PROFILE: "operator" });
      const config = applyAutonomyProfile(createTestConfig({
        creatorAddress: "0x8269eCC3D7fE1B36B8D88b445aa91bC31F90A7eE",
        allowUnsafeHostExecution: true,
        allowUnsafeLocalWorkers: true,
        enableAutonomousTopup: true,
      }), limits);

      expect(limits.maxExternalActionsPerDay).toBe(3);
      expect(config.enableFinancialOperations).toBe(true);
      expect(config.enableAutonomousTopup).toBe(false);
      expect(config.maxChildren).toBe(0);
      expect(config.treasuryPolicy).toMatchObject({
        maxSingleTransferCents: 25,
        maxDailyTransferCents: 100,
        minimumReserveCents: 1000,
        maxX402PaymentCents: 25,
        allowedTransferRecipients: ["0x8269eCC3D7fE1B36B8D88b445aa91bC31F90A7eE"],
        x402AllowedDomains: ["conway.tech"],
        maxTransfersPerTurn: 1,
      });
    } finally {
      if (previousMode === undefined) delete process.env.AUTOMATON_FINANCIAL_MODE;
      else process.env.AUTOMATON_FINANCIAL_MODE = previousMode;
    }
  });

  it("does not expose shell, installation, self-modification, children, or topup", () => {
    for (const tool of ["exec", "write_file", "install_npm_package", "install_mcp_server", "edit_own_file", "spawn_child", "topup_credits"]) {
      expect(OPERATOR_ALLOWED_TOOLS.has(tool)).toBe(false);
    }
    for (const tool of ["web_search", "send_message", "x402_fetch", "transfer_credits"]) {
      expect(OPERATOR_ALLOWED_TOOLS.has(tool)).toBe(true);
    }
  });

  it("fails closed at the daily external-action boundary", () => {
    expect(operatorDailyActionLimitReached(2, 0, 3)).toBe(false);
    expect(operatorDailyActionLimitReached(2, 1, 3)).toBe(true);
    expect(operatorDailyActionLimitReached(0, 0, 0)).toBe(true);
    expect(() => operatorDailyActionLimitReached(-1, 0, 3)).toThrow();
    expect(() => operatorDailyActionLimitReached(0.5, 0, 3)).toThrow();
  });
});
