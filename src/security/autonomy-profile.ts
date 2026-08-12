import type { AutomatonConfig, ModelStrategyConfig, TreasuryPolicy } from "../types.js";

export type AutonomyProfile = "default" | "research" | "operator";

export interface RuntimeAutonomyLimits {
  profile: AutonomyProfile;
  dailyInferenceBudgetCents: number;
  hourlyInferenceBudgetCents: number;
  perCallCeilingCents: number;
  maxTurnsPerCycle: number;
  maxTurnsPerDay: number;
  minTurnIntervalMs: number;
  maxExternalActionsPerDay: number;
  killSwitch: boolean;
}

function parseInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function resolveAutonomyLimits(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeAutonomyLimits {
  const rawProfile = (environment.AUTOMATON_AUTONOMY_PROFILE || "default").toLowerCase();
  if (rawProfile !== "default" && rawProfile !== "research" && rawProfile !== "operator") {
    throw new Error("AUTOMATON_AUTONOMY_PROFILE must be 'default', 'research', or 'operator'");
  }

  const bounded = rawProfile === "research" || rawProfile === "operator";
  return {
    profile: rawProfile,
    dailyInferenceBudgetCents: parseInteger(
      environment,
      "AUTOMATON_OPENAI_DAILY_BUDGET_CENTS",
      bounded ? 25 : 0,
      0,
      100_000,
    ),
    hourlyInferenceBudgetCents: parseInteger(
      environment,
      "AUTOMATON_OPENAI_HOURLY_BUDGET_CENTS",
      bounded ? 5 : 0,
      0,
      100_000,
    ),
    perCallCeilingCents: parseInteger(
      environment,
      "AUTOMATON_OPENAI_PER_CALL_CEILING_CENTS",
      bounded ? 2 : 0,
      0,
      100_000,
    ),
    maxTurnsPerCycle: parseInteger(
      environment,
      "AUTOMATON_MAX_TURNS_PER_CYCLE",
      bounded ? 3 : 25,
      1,
      1_000,
    ),
    maxTurnsPerDay: parseInteger(
      environment,
      "AUTOMATON_MAX_TURNS_PER_DAY",
      bounded ? 12 : 0,
      0,
      100_000,
    ),
    minTurnIntervalMs: parseInteger(
      environment,
      "AUTOMATON_MIN_TURN_INTERVAL_MS",
      bounded ? 900_000 : 0,
      0,
      86_400_000,
    ),
    maxExternalActionsPerDay: parseInteger(
      environment,
      "AUTOMATON_MAX_EXTERNAL_ACTIONS_PER_DAY",
      rawProfile === "operator" ? 3 : 0,
      0,
      1_000,
    ),
    killSwitch: environment.AUTOMATON_KILL_SWITCH?.toLowerCase() === "true",
  };
}

export function applyAutonomyProfile(
  config: AutomatonConfig,
  limits: RuntimeAutonomyLimits,
): AutomatonConfig {
  if (limits.profile === "default") return config;
  if (limits.profile === "research" && process.env.AUTOMATON_FINANCIAL_MODE === "treasury-gated") {
    throw new Error("Research autonomy refuses AUTOMATON_FINANCIAL_MODE=treasury-gated");
  }

  const modelStrategy: ModelStrategyConfig = {
    inferenceModel: "gpt-5-mini",
    lowComputeModel: "gpt-5-mini",
    criticalModel: "gpt-5-mini",
    maxTokensPerTurn: Math.min(config.modelStrategy?.maxTokensPerTurn || config.maxTokensPerTurn, 4096),
    hourlyBudgetCents: limits.hourlyInferenceBudgetCents,
    dailyBudgetCents: limits.dailyInferenceBudgetCents,
    sessionBudgetCents: 0,
    perCallCeilingCents: limits.perCallCeilingCents,
    enableModelFallback: false,
    anthropicApiVersion: config.modelStrategy?.anthropicApiVersion || "2023-06-01",
  };

  const boundedConfig: AutomatonConfig = {
    ...config,
    inferenceModel: "gpt-5-mini",
    maxTurnsPerCycle: limits.maxTurnsPerCycle,
    maxChildren: 0,
    allowUnsafeLocalWorkers: false,
    allowUnsafeHostExecution: false,
    enableAutonomousTopup: false,
    enableFinancialOperations: limits.profile === "operator"
      && process.env.AUTOMATON_FINANCIAL_MODE === "treasury-gated",
    socialRelayUrl: limits.profile === "research" ? undefined : config.socialRelayUrl,
    modelStrategy,
  };

  if (limits.profile === "research") return boundedConfig;

  const treasuryPolicy: TreasuryPolicy = {
    maxSingleTransferCents: 25,
    maxHourlyTransferCents: 25,
    maxDailyTransferCents: 100,
    minimumReserveCents: 1000,
    maxX402PaymentCents: 25,
    x402AllowedDomains: ["conway.tech"],
    allowedTransferRecipients: config.creatorAddress ? [config.creatorAddress] : [],
    transferCooldownMs: 900_000,
    maxTransfersPerTurn: 1,
    maxInferenceDailyCents: limits.dailyInferenceBudgetCents,
    requireConfirmationAboveCents: 25,
  };

  return { ...boundedConfig, treasuryPolicy };
}

/** Backward-compatible name for callers that have not migrated yet. */
export const applyResearchProfile = applyAutonomyProfile;

export const RESEARCH_ALLOWED_TOOLS = new Set([
  "web_search",
  "fetch_public_page",
  "remember_fact",
  "recall_facts",
  "review_memory",
  "forget",
  "save_procedure",
  "recall_procedure",
  "set_goal",
  "list_goals",
  "complete_goal",
  "cancel_goal",
  "get_plan",
  "check_inference_spending",
  "list_models",
  "system_synopsis",
  "sleep",
]);

export const OPERATOR_ALLOWED_TOOLS = new Set([
  ...RESEARCH_ALLOWED_TOOLS,
  "check_credits",
  "check_usdc_balance",
  "transfer_credits",
  "x402_fetch",
  "send_message",
]);

export const OPERATOR_EXTERNAL_ACTION_TOOLS = new Set([
  "transfer_credits",
  "x402_fetch",
  "send_message",
]);

export function operatorDailyActionLimitReached(
  persistedAttempts: number,
  currentTurnAttempts: number,
  maximumPerDay: number,
): boolean {
  if (![persistedAttempts, currentTurnAttempts, maximumPerDay].every(Number.isInteger)) {
    throw new Error("Operator action counters must be integers");
  }
  if (persistedAttempts < 0 || currentTurnAttempts < 0 || maximumPerDay < 0) {
    throw new Error("Operator action counters cannot be negative");
  }
  return persistedAttempts + currentTurnAttempts >= maximumPerDay;
}
