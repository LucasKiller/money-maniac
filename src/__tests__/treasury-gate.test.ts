import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomatonDatabase } from "../types.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import { TreasuryDeniedError, TreasuryGate } from "../agent/treasury-gate.js";
import { createTestDb, MockConwayClient } from "./mocks.js";

describe("TreasuryGate financial invariants", () => {
  const databases: AutomatonDatabase[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    vi.restoreAllMocks();
  });

  function setup(overrides = {}) {
    const db = createTestDb();
    databases.push(db);
    const conway = new MockConwayClient();
    const policy = { ...DEFAULT_TREASURY_POLICY, ...overrides };
    return { db, conway, gate: new TreasuryGate(db.raw, conway, policy) };
  }

  it("fails closed when the balance API is unavailable", async () => {
    const { db, conway, gate } = setup();
    vi.spyOn(conway, "getCreditsBalance").mockRejectedValueOnce(new Error("offline"));

    await expect(gate.executeCreditTransfer({
      operation: "credit_transfer",
      recipient: "0xrecipient",
      amountCents: 100,
    })).rejects.toMatchObject({ code: "BALANCE_UNKNOWN" });

    expect((db.raw.prepare("SELECT COUNT(*) AS count FROM treasury_intents").get() as { count: number }).count).toBe(0);
  });

  it("enforces minimum reserve at the execution boundary", async () => {
    const { conway, gate } = setup();
    conway.creditsCents = 1_500;

    await expect(gate.executeCreditTransfer({
      operation: "credit_transfer",
      recipient: "0xrecipient",
      amountCents: 600,
    })).rejects.toMatchObject({ code: "MINIMUM_RESERVE" });
  });

  it("serializes concurrent transfers and reserves cumulative limits", async () => {
    const { db, gate } = setup({
      maxHourlyTransferCents: 5_000,
      maxDailyTransferCents: 5_000,
    });

    const results = await Promise.allSettled([
      gate.executeCreditTransfer({ operation: "credit_transfer", recipient: "0xa", amountCents: 3_000 }),
      gate.executeCreditTransfer({ operation: "credit_transfer", recipient: "0xb", amountCents: 3_000 }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((db.raw.prepare("SELECT COUNT(*) AS count FROM treasury_intents WHERE status='settled'").get() as { count: number }).count).toBe(1);
  });

  it("reuses the durable idempotency key at the Conway request boundary", async () => {
    const { conway, gate } = setup();
    const spy = vi.spyOn(conway, "transferCredits");

    await gate.executeCreditTransfer({
      operation: "credit_transfer",
      recipient: "0xrecipient",
      amountCents: 100,
      idempotencyKey: "intent-key-1",
    });

    expect(spy).toHaveBeenCalledWith(
      "0xrecipient",
      100,
      undefined,
      { idempotencyKey: "intent-key-1" },
    );
  });

  it("marks submitted failures uncertain and blocks blind retry", async () => {
    const { db, conway, gate } = setup();
    vi.spyOn(conway, "transferCredits").mockRejectedValueOnce(new Error("connection reset after submit"));

    await expect(gate.executeCreditTransfer({
      operation: "credit_transfer",
      recipient: "0xrecipient",
      amountCents: 100,
    })).rejects.toThrow("connection reset");

    const row = db.raw.prepare("SELECT status FROM treasury_intents").get() as { status: string };
    expect(row.status).toBe("uncertain");
    await expect(gate.executeCreditTransfer({
      operation: "credit_transfer",
      recipient: "0xother",
      amountCents: 100,
    })).rejects.toMatchObject({ code: "UNRESOLVED_FINANCIAL_INTENT" });
  });

  it("requires evidence and records a settled reconciliation exactly once", async () => {
    const { db, conway, gate } = setup();
    vi.spyOn(conway, "transferCredits").mockRejectedValueOnce(new Error("connection reset after submit"));

    await expect(gate.executeCreditTransfer({
      operation: "credit_transfer",
      recipient: "0xrecipient",
      amountCents: 100,
      idempotencyKey: "reconcile-settled",
    })).rejects.toThrow("connection reset");

    const intent = db.raw.prepare("SELECT id FROM treasury_intents WHERE idempotency_key = ?")
      .get("reconcile-settled") as { id: string };
    expect(() => gate.reconcileIntent(intent.id, { outcome: "settled", evidence: "" }))
      .toThrow("durable evidence");

    gate.reconcileIntent(intent.id, {
      outcome: "settled",
      evidence: "provider transfer tr_123 confirmed",
      externalId: "tr_123",
      balanceAfterCents: 900,
    });

    expect(db.raw.prepare("SELECT status FROM treasury_intents WHERE id = ?").get(intent.id))
      .toEqual({ status: "settled" });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM spend_tracking WHERE id = ?").get(intent.id))
      .toEqual({ count: 1 });
    expect(() => gate.reconcileIntent(intent.id, {
      outcome: "settled",
      evidence: "duplicate confirmation",
    })).toThrow("cannot settle");
  });

  it("unblocks operations after evidence proves an uncertain request was not settled", async () => {
    const { db, conway, gate } = setup();
    vi.spyOn(conway, "transferCredits")
      .mockRejectedValueOnce(new Error("connection reset after submit"))
      .mockResolvedValueOnce({ transferId: "tr_second", status: "completed", balanceAfterCents: 850 });

    await expect(gate.executeCreditTransfer({
      operation: "credit_transfer",
      recipient: "0xrecipient",
      amountCents: 100,
      idempotencyKey: "reconcile-not-settled",
    })).rejects.toThrow();
    const intent = db.raw.prepare("SELECT id FROM treasury_intents WHERE idempotency_key = ?")
      .get("reconcile-not-settled") as { id: string };

    gate.reconcileIntent(intent.id, {
      outcome: "not_settled",
      evidence: "provider idempotency lookup returned not found",
    });
    await expect(gate.executeCreditTransfer({
      operation: "credit_transfer",
      recipient: "0xother",
      amountCents: 50,
      idempotencyKey: "fresh-after-reconcile",
    })).resolves.toMatchObject({ intentId: expect.any(String) });
  });

  it("denies non-allowlisted x402 domains and duplicate idempotency keys", async () => {
    const { gate } = setup();
    await expect(gate.reservePayment({
      operation: "x402",
      amountCents: 1,
      domain: "evil.example",
    })).rejects.toMatchObject({ code: "X402_DOMAIN_DENIED" });

    const auth = await gate.reservePayment({
      operation: "x402",
      amountCents: 1,
      domain: "api.conway.tech",
      idempotencyKey: "same-key",
    });
    gate.markFailed(auth.intentId, "cancelled before signing", false);
    await expect(gate.reservePayment({
      operation: "x402",
      amountCents: 1,
      domain: "api.conway.tech",
      idempotencyKey: "same-key",
    })).rejects.toBeInstanceOf(TreasuryDeniedError);
  });
});
