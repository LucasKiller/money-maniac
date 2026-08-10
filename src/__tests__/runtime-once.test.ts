import { describe, expect, it, vi } from "vitest";
import { executeOnce, resolveOnceTimeout } from "../runtime/once.js";
import { createTestConfig } from "./mocks.js";
import type { InferenceClient, InferenceResponse } from "../types.js";

function response(overrides: Partial<InferenceResponse> = {}): InferenceResponse {
  return {
    id: "once-1",
    model: "gpt-5-mini",
    message: { role: "assistant", content: "Ready." },
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    finishReason: "stop",
    ...overrides,
  };
}

function inferenceReturning(value: InferenceResponse): InferenceClient {
  return {
    chat: vi.fn().mockResolvedValue(value),
    setLowComputeMode: vi.fn(),
    getDefaultModel: vi.fn().mockReturnValue("gpt-5-mini"),
  };
}

describe("supervised one-shot runtime", () => {
  it("performs exactly one inference without exposing tools", async () => {
    const inference = inferenceReturning(response());
    const config = createTestConfig({
      inferenceModel: "gpt-5-mini",
      maxTokensPerTurn: 2048,
    });

    const result = await executeOnce(
      { prompt: "Report readiness.", timeoutMs: 1_000 },
      { config, openaiApiKey: "test-key", inference },
    );

    expect(inference.chat).toHaveBeenCalledTimes(1);
    const [, options] = vi.mocked(inference.chat).mock.calls[0];
    expect(options?.tools).toBeUndefined();
    expect(options?.maxTokens).toBe(256);
    expect(result.content).toBe("Ready.");
    expect(result.tokenUsage.totalTokens).toBe(12);
  });

  it("denies any returned tool call", async () => {
    const inference = inferenceReturning(response({
      toolCalls: [{
        id: "call-1",
        type: "function",
        function: { name: "exec", arguments: "{}" },
      }],
    }));
    const config = createTestConfig({ inferenceModel: "gpt-5-mini" });

    await expect(executeOnce(
      { prompt: "Do something.", timeoutMs: 1_000 },
      { config, openaiApiKey: "test-key", inference },
    )).rejects.toThrow("tool call");
  });

  it("fails when the supervised timeout expires", async () => {
    const inference: InferenceClient = {
      chat: vi.fn().mockReturnValue(new Promise(() => {})),
      setLowComputeMode: vi.fn(),
      getDefaultModel: vi.fn().mockReturnValue("gpt-5-mini"),
    };
    const config = createTestConfig({ inferenceModel: "gpt-5-mini" });

    await expect(executeOnce(
      { prompt: "Wait forever.", timeoutMs: 1_000 },
      { config, openaiApiKey: "test-key", inference },
    )).rejects.toThrow("timed out");
  });

  it("fails closed without a direct OpenAI key", async () => {
    const config = createTestConfig({ inferenceModel: "gpt-5-mini" });
    await expect(executeOnce(
      { prompt: "Report readiness.", timeoutMs: 1_000 },
      { config, openaiApiKey: "", inference: inferenceReturning(response()) },
    )).rejects.toThrow("OPENAI_API_KEY");
  });

  it("rejects non-OpenAI models and oversized prompts", async () => {
    const inference = inferenceReturning(response());
    await expect(executeOnce(
      { prompt: "Report readiness.", timeoutMs: 1_000 },
      {
        config: createTestConfig({ inferenceModel: "claude-sonnet" }),
        openaiApiKey: "test-key",
        inference,
      },
    )).rejects.toThrow("direct OpenAI model");

    await expect(executeOnce(
      { prompt: "x".repeat(4_001), timeoutMs: 1_000 },
      {
        config: createTestConfig({ inferenceModel: "gpt-5-mini" }),
        openaiApiKey: "test-key",
        inference,
      },
    )).rejects.toThrow("exceeds 4000");
  });

  it("validates timeout configuration", () => {
    expect(resolveOnceTimeout(undefined)).toBe(30_000);
    expect(resolveOnceTimeout("1500")).toBe(1_500);
    expect(() => resolveOnceTimeout("999")).toThrow("between 1000 and 60000");
    expect(() => resolveOnceTimeout("not-a-number")).toThrow("between 1000 and 60000");
  });
});
