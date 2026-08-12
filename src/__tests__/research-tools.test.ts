import { describe, expect, it, vi } from "vitest";
import { assertPublicHttpsUrl, createResearchTools } from "../agent/research-tools.js";

const publicResolver = async () => ["93.184.216.34"];

describe("research web tools", () => {
  it("rejects non-HTTPS and private destinations", async () => {
    await expect(assertPublicHttpsUrl("http://example.com", publicResolver)).rejects.toThrow("HTTPS");
    await expect(assertPublicHttpsUrl("https://localhost", publicResolver)).rejects.toThrow("Private");
    await expect(assertPublicHttpsUrl("https://example.com:8443", publicResolver)).rejects.toThrow("443");
    await expect(assertPublicHttpsUrl("https://example.com", async () => ["10.0.0.5"]))
      .rejects.toThrow("SSRF");
    await expect(assertPublicHttpsUrl("https://[::ffff:192.168.1.2]", publicResolver))
      .rejects.toThrow("SSRF");
  });

  it("returns bounded untrusted search results", async () => {
    const html = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fmarket">Market report</a>';
    const fetchFn = vi.fn().mockResolvedValue(new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }));
    const tool = createResearchTools({ resolveHost: publicResolver, fetchFn })
      .find((candidate) => candidate.name === "web_search")!;
    const output = await tool.execute({ query: "Brazil B2B market" }, {} as never);
    expect(output).toContain("UNTRUSTED PUBLIC WEB RESULTS");
    expect(output).toContain("https://example.com/market");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized responses", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("x", {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "content-length": "100001",
      },
    }));
    const tool = createResearchTools({ resolveHost: publicResolver, fetchFn })
      .find((candidate) => candidate.name === "fetch_public_page")!;
    await expect(tool.execute({ url: "https://example.com" }, {} as never))
      .rejects.toThrow("100000 bytes");
  });
});
