import { describe, expect, it } from "vitest";
import { isFinancialExecutionEnabled } from "../security/financial-mode.js";

describe("financial execution two-key activation", () => {
  it("is disabled by default", () => {
    expect(isFinancialExecutionEnabled({}, {})).toBe(false);
  });

  it("rejects configuration-only activation", () => {
    expect(isFinancialExecutionEnabled(
      { enableFinancialOperations: true },
      {},
    )).toBe(false);
  });

  it("rejects environment-only activation", () => {
    expect(isFinancialExecutionEnabled(
      { enableFinancialOperations: false },
      { AUTOMATON_FINANCIAL_MODE: "treasury-gated" },
    )).toBe(false);
  });

  it("enables only when both independent controls match exactly", () => {
    expect(isFinancialExecutionEnabled(
      { enableFinancialOperations: true },
      { AUTOMATON_FINANCIAL_MODE: "treasury-gated" },
    )).toBe(true);
    expect(isFinancialExecutionEnabled(
      { enableFinancialOperations: true },
      { AUTOMATON_FINANCIAL_MODE: "TREASURY-GATED" },
    )).toBe(false);
  });
});
