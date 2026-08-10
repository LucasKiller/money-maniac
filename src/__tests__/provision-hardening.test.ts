import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { EvmChainIdentity } from "../identity/chain.js";
import { provision } from "../identity/provision.js";

describe("provisioning nonce safety", () => {
  it("never retries nonce, verify, or API-key creation requests", async () => {
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const requests: Array<{ url: string; options: RequestInit & { retries?: number } }> = [];
    const responses = [
      Response.json({ nonce: "nonce1234567890" }),
      Response.json({ access_token: "jwt" }),
      Response.json({ key: "test-key", key_prefix: "test" }),
    ];
    const request = vi.fn(async (url: string, options?: RequestInit & { retries?: number }) => {
      requests.push({ url, options: options ?? {} });
      return responses.shift()!;
    });
    const persistConfig = vi.fn();

    await provision("https://api.conway.tech", undefined, {
      httpClient: { request },
      walletLoader: async () => ({
        account,
        chainIdentity: new EvmChainIdentity(account),
        chainType: "evm",
        isNew: false,
      }),
      persistConfig,
    });

    expect(requests.map(({ url, options }) => ({
      path: new URL(url).pathname,
      retries: options.retries,
    }))).toEqual([
      { path: "/v1/auth/nonce", retries: 0 },
      { path: "/v1/auth/verify", retries: 0 },
      { path: "/v1/auth/api-keys", retries: 0 },
    ]);
    expect(persistConfig).toHaveBeenCalledWith("test-key", account.address);
  });
});
