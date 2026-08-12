import type { AutomatonConfig, ModelStrategyConfig } from "../types.js";

export type AutonomyProfile = "default" | "research";

export interface RuntimeAutonomyLimits {
  profile: AutonomyProfile;
  dailyInferenceBudgetCents: number;
  hourlyInferenceBudgetCents: number;
  perCallCeilingCents: number;
  maxTurnsPerCycle: number;
  maxTurnsPerDay: number;
  minTurnIntervalMs: number;
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
  if (rawProfile !== "default" && rawProfile !== "research") {
    throw new Error("AUTOMATON_AUTONOMY_PROFILE must be 'default' or 'research'");
  }

  const research = rawProfile === "research";
  return {
    profile: rawProfile,
    dailyInferenceBudgetCents: parseInteger(
      environment,
      "AUTOMATON_OPENAI_DAILY_BUDGET_CENTS",
      research ? 25 : 0,
      0,
      100_000,
    ),
    hourlyInferenceBudgetCents: parseInteger(
      environment,
      "AUTOMATON_OPENAI_HOURLY_BUDGET_CENTS",
      research ? 5 : 0,
      0,
      100_000,
    ),
    perCallCeilingCents: parseInteger(
      environment,
      "AUTOMATON_OPENAI_PER_CALL_CEILING_CENTS",
      research ? 2 : 0,
      0,
      100_000,
    ),
    maxTurnsPerCycle: parseInteger(
      environment,
      "AUTOMATON_MAX_TURNS_PER_CYCLE",
      research ? 3 : 25,
      1,
      1_000,
    ),
    maxTurnsPerDay: parseInteger(
      environment,
      "AUTOMATON_MAX_TURNS_PER_DAY",
      research ? 12 : 0,
      0,
      100_000,
    ),
    minTurnIntervalMs: parseInteger(
      environment,
      "AUTOMATON_MIN_TURN_INTERVAL_MS",
      research ? 900_000 : 0,
      0,
      86_400_000,
    ),
    killSwitch: environment.AUTOMATON_KILL_SWITCH?.toLowerCase() === "true",
  };
}

export function applyResearchProfile(
  config: AutomatonConfig,
  limits: RuntimeAutonomyLimits,
): AutomatonConfig {
  if (limits.profile !== "research") return config;
  if (process.env.AUTOMATON_FINANCIAL_MODE === "treasury-gated") {
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

  return {
    ...config,
    inferenceModel: "gpt-5-mini",
    maxTurnsPerCycle: limits.maxTurnsPerCycle,
    maxChildren: 0,
    allowUnsafeLocalWorkers: false,
    allowUnsafeHostExecution: false,
    enableAutonomousTopup: false,
    enableFinancialOperations: false,
    socialRelayUrl: undefined,
    modelStrategy,
  };
}

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
