import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeOnce,
  ONCE_SYSTEM_PROMPT,
  resolveOnceTimeout,
} from "../runtime/once.js";
import { createInferenceClient } from "../conway/inference.js";
import { createTestConfig } from "./mocks.js";
import type { InferenceClient, InferenceResponse } from "../types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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
    const [messages] = vi.mocked(inference.chat).mock.calls[0];
    expect(messages[0]).toMatchObject({
      role: "system",
      content: ONCE_SYSTEM_PROMPT,
    });
    expect(messages[0]?.content).toContain("Optimize for profitable outcomes.");
    expect(messages[0]?.content).toContain("No tools are available.");
    const [, options] = vi.mocked(inference.chat).mock.calls[0];
    expect(options?.tools).toBeUndefined();
    expect(options?.maxTokens).toBe(2_048);
    expect(options?.reasoningEffort).toBe("minimal");
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

  it("reports usage when the model exhausts output without text", async () => {
    const inference = inferenceReturning(response({
      message: { role: "assistant", content: "" },
      usage: { promptTokens: 90, completionTokens: 256, totalTokens: 346 },
      finishReason: "length",
    }));
    const config = createTestConfig({ inferenceModel: "gpt-5-mini" });

    await expect(executeOnce(
      { prompt: "Analyze risks.", timeoutMs: 1_000 },
      { config, openaiApiKey: "test-key", inference },
    )).rejects.toThrow("completionTokens=256, finishReason=length");
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

  it("can enforce one HTTP attempt for supervised inference", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("temporary failure", { status: 500 }),
    );
    const client = createInferenceClient({
      apiUrl: "https://api.conway.tech",
      apiKey: "",
      defaultModel: "gpt-5-mini",
      maxTokens: 32,
      openaiApiKey: "test-key",
      maxRetries: 0,
      requestTimeoutMs: 1_000,
    });

    await expect(client.chat(
      [{ role: "user", content: "Report readiness." }],
      { reasoningEffort: "low" },
    )).rejects.toThrow("Inference error (openai): 500");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      reasoning_effort: "low",
    });
    fetchMock.mockRestore();
  });

  it("aborts the in-flight HTTP request at the supervised deadline", async () => {
    let observedAbort = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          observedAbort = true;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      }),
    );
    const client = createInferenceClient({
      apiUrl: "https://api.conway.tech",
      apiKey: "",
      defaultModel: "gpt-5-mini",
      maxTokens: 32,
      openaiApiKey: "test-key",
      maxRetries: 0,
      requestTimeoutMs: 25,
    });

    await expect(client.chat([
      { role: "user", content: "Report readiness." },
    ])).rejects.toThrow();
    expect(observedAbort).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });
});
