import { loadConfig } from "../config.js";
import { createInferenceClient } from "../conway/inference.js";
import type {
  AutomatonConfig,
  InferenceClient,
  InferenceResponse,
} from "../types.js";

const DEFAULT_ONCE_TIMEOUT_MS = 30_000;
const MAX_ONCE_TIMEOUT_MS = 60_000;
const MAX_ONCE_PROMPT_CHARS = 4_000;
// GPT-5 reasoning tokens share the completion-token budget. A very small cap
// can produce a successful response with no user-visible text, so reserve
// enough room for both bounded reasoning and a concise final answer.
const MAX_ONCE_OUTPUT_TOKENS = 1_024;

const ONCE_SYSTEM_PROMPT = `You are running in supervised one-shot validation mode.
Answer the user's request, but do not request or claim to execute tools, shell commands,
payments, blockchain operations, network actions, child agents, self-modification, or
persistent changes. No tools are available. Keep the answer concise and factual.`;

export interface OnceRunOptions {
  prompt: string;
  timeoutMs?: number;
}

export interface OnceRunResult {
  model: string;
  content: string;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: string;
}

export interface OnceExecutionDependencies {
  config: AutomatonConfig;
  openaiApiKey: string;
  inference: InferenceClient;
}

function validatePrompt(prompt: string): string {
  const normalized = prompt.trim();
  if (!normalized) {
    throw new Error("One-shot prompt must not be empty");
  }
  if (normalized.length > MAX_ONCE_PROMPT_CHARS) {
    throw new Error(
      `One-shot prompt exceeds ${MAX_ONCE_PROMPT_CHARS} characters`,
    );
  }
  return normalized;
}

function validateTimeout(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? DEFAULT_ONCE_TIMEOUT_MS;
  if (!Number.isInteger(resolved) || resolved < 1_000 || resolved > MAX_ONCE_TIMEOUT_MS) {
    throw new Error(
      `One-shot timeout must be an integer between 1000 and ${MAX_ONCE_TIMEOUT_MS} ms`,
    );
  }
  return resolved;
}

function assertOpenAiModel(model: string): void {
  if (!/^(gpt-|o[1-9](?:-|$))/i.test(model)) {
    throw new Error(
      `One-shot mode only supports a direct OpenAI model; configured model is '${model}'`,
    );
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`One-shot inference timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function executeOnce(
  options: OnceRunOptions,
  dependencies: OnceExecutionDependencies,
): Promise<OnceRunResult> {
  const prompt = validatePrompt(options.prompt);
  const timeoutMs = validateTimeout(options.timeoutMs);
  const model = dependencies.config.inferenceModel;

  if (!dependencies.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required for one-shot mode");
  }
  assertOpenAiModel(model);

  const response: InferenceResponse = await withTimeout(
    dependencies.inference.chat(
      [
        { role: "system", content: ONCE_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      {
        model,
        maxTokens: Math.min(
          dependencies.config.maxTokensPerTurn,
          MAX_ONCE_OUTPUT_TOKENS,
        ),
        // Deliberately omit tools. One-shot mode has no execution capability.
      },
    ),
    timeoutMs,
  );

  if (response.toolCalls?.length || response.message.tool_calls?.length) {
    throw new Error("One-shot inference returned a tool call; execution denied");
  }

  const content = response.message.content.trim();
  if (!content) {
    throw new Error(
      "One-shot inference returned no textual content " +
      `(completionTokens=${response.usage.completionTokens}, finishReason=${response.finishReason})`,
    );
  }

  return {
    model: response.model,
    content,
    tokenUsage: response.usage,
    finishReason: response.finishReason,
  };
}

export async function runOnce(options: OnceRunOptions): Promise<OnceRunResult> {
  const config = loadConfig();
  if (!config) {
    throw new Error("Automaton is not configured");
  }

  const openaiApiKey = process.env.OPENAI_API_KEY || config.openaiApiKey || "";
  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required for one-shot mode");
  }

  assertOpenAiModel(config.inferenceModel);
  const timeoutMs = validateTimeout(options.timeoutMs);

  const inference = createInferenceClient({
    apiUrl: config.conwayApiUrl,
    apiKey: "",
    defaultModel: config.inferenceModel,
    maxTokens: Math.min(config.maxTokensPerTurn, MAX_ONCE_OUTPUT_TOKENS),
    lowComputeModel: "gpt-5-mini",
    openaiApiKey,
    requestTimeoutMs: timeoutMs,
    maxRetries: 0,
  });

  return executeOnce(
    { ...options, timeoutMs },
    { config, openaiApiKey, inference },
  );
}

export function resolveOnceTimeout(raw: string | undefined): number {
  if (!raw) return DEFAULT_ONCE_TIMEOUT_MS;
  return validateTimeout(Number(raw));
}
