import { describe, expect, it } from "vitest";
import {
  applyResearchProfile,
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
