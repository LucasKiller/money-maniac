import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { AutomatonDatabase } from "../types.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import { TreasuryGate } from "../agent/treasury-gate.js";
import { x402Fetch } from "../conway/x402.js";
import { createTestDb, MockConwayClient } from "./mocks.js";

const ACCOUNT = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

function paymentRequired(asset = USDC): Response {
  return new Response(JSON.stringify({
    x402Version: 2,
    accepts: [{
      scheme: "exact",
      network: "eip155:8453",
      maxAmountRequired: "10000",
      payTo: RECIPIENT,
      asset,
      maxTimeoutSeconds: 300,
    }],
  }), { status: 402, headers: { "Content-Type": "application/json" } });
}

describe("x402 Treasury boundary", () => {
  const databases: AutomatonDatabase[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function gate() {
    const db = createTestDb();
    databases.push(db);
    return { db, gate: new TreasuryGate(db.raw, new MockConwayClient(), DEFAULT_TREASURY_POLICY) };
  }

  it("refuses to sign when no TreasuryGate is present", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => paymentRequired()));
    const result = await x402Fetch("https://api.conway.tech/paid", ACCOUNT, "GET", undefined, undefined, 100);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Treasury authorization");
  });

  it("pins the USDC contract before signing", async () => {
    const setup = gate();
    vi.stubGlobal("fetch", vi.fn(async () => paymentRequired("0x2222222222222222222222222222222222222222")));
    const signer = vi.spyOn(ACCOUNT, "signTypedData");
    const result = await x402Fetch("https://api.conway.tech/paid", ACCOUNT, "GET", undefined, undefined, 100, "evm", setup.gate);
    expect(result.success).toBe(false);
    expect(result.error).toContain("pinned USDC");
    expect(signer).not.toHaveBeenCalled();
  });

  it("records the exact payment amount and settlement", async () => {
    const setup = gate();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(paymentRequired())
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await x402Fetch("https://api.conway.tech/paid", ACCOUNT, "GET", undefined, undefined, 100, "evm", setup.gate);
    expect(result).toMatchObject({ success: true, amountCents: 1, paymentAttempted: true });
    const intent = setup.db.raw.prepare("SELECT status, amount_cents FROM treasury_intents").get() as { status: string; amount_cents: number };
    expect(intent).toEqual({ status: "settled", amount_cents: 1 });
    const spend = setup.db.raw.prepare("SELECT amount_cents FROM spend_tracking WHERE category='x402'").get() as { amount_cents: number };
    expect(spend.amount_cents).toBe(1);
  });

  it("keeps a failed paid request uncertain and blocks a second payment", async () => {
    const setup = gate();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(paymentRequired())
      .mockResolvedValueOnce(new Response("backend failed", { status: 500 }))
      .mockResolvedValueOnce(paymentRequired());
    vi.stubGlobal("fetch", fetchMock);

    const first = await x402Fetch("https://api.conway.tech/paid", ACCOUNT, "GET", undefined, undefined, 100, "evm", setup.gate);
    expect(first.success).toBe(false);
    expect(first.error).toContain("uncertain");
    expect((setup.db.raw.prepare("SELECT status FROM treasury_intents").get() as { status: string }).status).toBe("uncertain");

    const second = await x402Fetch("https://api.conway.tech/paid", ACCOUNT, "GET", undefined, undefined, 100, "evm", setup.gate);
    expect(second.success).toBe(false);
    expect(second.error).toContain("reconcile");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
