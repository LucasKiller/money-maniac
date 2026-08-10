import type { AutomatonConfig } from "../types.js";

export const TREASURY_GATED_MODE = "treasury-gated";

/** Financial execution requires independent persisted and runtime activation. */
export function isFinancialExecutionEnabled(
  config: Pick<AutomatonConfig, "enableFinancialOperations">,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return config.enableFinancialOperations === true
    && environment.AUTOMATON_FINANCIAL_MODE === TREASURY_GATED_MODE;
}
