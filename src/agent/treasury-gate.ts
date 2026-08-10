import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type {
  ConwayClient,
  TreasuryAuthorization,
  TreasuryGateInterface,
  TreasuryIntentRequest,
  TreasuryIntentStatus,
  TreasuryPolicy,
  TreasuryReconciliation,
  TreasuryTransferResult,
} from "../types.js";

const ACTIVE_OR_UNCERTAIN = ["reserved", "signed", "submitted", "uncertain"] as const;

interface IntentRow {
  id: string;
  idempotency_key: string;
  operation: string;
  status: TreasuryIntentStatus;
  amount_cents: number;
  recipient: string | null;
  domain: string | null;
}

export class TreasuryDeniedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TreasuryDeniedError";
  }
}

/**
 * Durable, fail-closed authorization boundary for transfers and x402 payments.
 * One unresolved financial intent blocks every later payment until it is
 * explicitly reconciled, preventing blind retries after an uncertain result.
 */
export class TreasuryGate implements TreasuryGateInterface {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Database.Database,
    private readonly conway: ConwayClient,
    private readonly policy: TreasuryPolicy,
  ) {}

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  async executeCreditTransfer(
    request: TreasuryIntentRequest & { recipient: string; note?: string },
  ): Promise<TreasuryTransferResult> {
    return this.withLock(async () => {
      this.validateRequest(request);
      if (request.operation !== "credit_transfer" && request.operation !== "child_funding") {
        throw new TreasuryDeniedError("OPERATION_DENIED", "Credit transfer gate received a non-transfer operation");
      }

      this.assertNoUnresolvedIntent();
      const balance = await this.getKnownCreditsBalance();
      this.assertTransferLimits(request.amountCents, balance);

      const auth = this.insertIntent(request, balance);
      this.transition(auth.intentId, ["reserved"], "submitted");

      try {
        const transfer = await this.conway.transferCredits(
          request.recipient,
          request.amountCents,
          request.note,
          { idempotencyKey: auth.idempotencyKey },
        );
        const balanceAfter = transfer.balanceAfterCents ?? balance - request.amountCents;
        this.settle(auth.intentId, balanceAfter, {
          externalId: transfer.transferId,
          status: transfer.status,
        });
        return { intentId: auth.intentId, transfer, balanceBeforeCents: balance };
      } catch (error) {
        // Once the backend request was submitted, its outcome is unknown until
        // reconciliation proves otherwise. Never silently retry it.
        this.markFailed(
          auth.intentId,
          error instanceof Error ? error.message : String(error),
          true,
        );
        throw error;
      }
    });
  }

  reservePayment(request: TreasuryIntentRequest): Promise<TreasuryAuthorization> {
    return this.withLock(async () => {
      this.validateRequest(request);
      if (request.operation !== "x402" && request.operation !== "credit_topup") {
        throw new TreasuryDeniedError("OPERATION_DENIED", "Payment reservation requires an x402 operation");
      }
      this.assertNoUnresolvedIntent();
      this.assertPaymentLimits(request);
      return this.insertIntent(request, null);
    });
  }

  markSigned(intentId: string, metadata?: Record<string, unknown>): void {
    this.transition(intentId, ["reserved"], "signed", metadata);
  }

  markSubmitted(intentId: string, metadata?: Record<string, unknown>): void {
    this.transition(intentId, ["signed"], "submitted", metadata);
  }

  markSettled(intentId: string, metadata?: Record<string, unknown>): void {
    this.settle(intentId, null, metadata);
  }

  markFailed(intentId: string, error: string, uncertain = false): void {
    const target: TreasuryIntentStatus = uncertain ? "uncertain" : "failed";
    const result = this.db.prepare(
      `UPDATE treasury_intents
       SET status = ?, error = ?, updated_at = ?
       WHERE id = ? AND status IN ('reserved', 'signed', 'submitted')`,
    ).run(target, error.slice(0, 4000), new Date().toISOString(), intentId);
    if (result.changes !== 1) {
      throw new TreasuryDeniedError("INVALID_INTENT_STATE", `Cannot mark treasury intent ${intentId} as ${target}`);
    }
  }

  /** Resolve an uncertain intent using independently verified evidence. */
  reconcileIntent(intentId: string, reconciliation: TreasuryReconciliation): void {
    const evidence = reconciliation.evidence.trim();
    if (!evidence) {
      throw new TreasuryDeniedError("RECONCILIATION_EVIDENCE_REQUIRED", "Reconciliation requires durable evidence");
    }
    if (
      reconciliation.balanceAfterCents !== undefined
      && (!Number.isSafeInteger(reconciliation.balanceAfterCents) || reconciliation.balanceAfterCents < 0)
    ) {
      throw new TreasuryDeniedError("INVALID_BALANCE", "Reconciled balance must be a non-negative integer number of cents");
    }

    const metadata = {
      ...reconciliation.metadata,
      reconciliationEvidence: evidence.slice(0, 4000),
      externalId: reconciliation.externalId,
    };
    if (reconciliation.outcome === "settled") {
      this.settle(intentId, reconciliation.balanceAfterCents ?? null, metadata, ["uncertain"]);
      return;
    }

    const now = new Date().toISOString();
    const result = this.db.prepare(
      `UPDATE treasury_intents
       SET status = 'reconciled', metadata = ?, error = NULL, updated_at = ?, settled_at = ?
       WHERE id = ? AND status = 'uncertain'`,
    ).run(JSON.stringify(metadata), now, now, intentId);
    if (result.changes !== 1) {
      throw new TreasuryDeniedError("INVALID_INTENT_STATE", `Treasury intent ${intentId} is not awaiting reconciliation`);
    }
  }

  private validateRequest(request: TreasuryIntentRequest): void {
    if (!Number.isSafeInteger(request.amountCents) || request.amountCents <= 0) {
      throw new TreasuryDeniedError("INVALID_AMOUNT", "Financial amount must be a positive integer number of cents");
    }
    if ((request.operation === "credit_transfer" || request.operation === "child_funding") && !request.recipient) {
      throw new TreasuryDeniedError("RECIPIENT_REQUIRED", "Transfer recipient is required");
    }
    if ((request.operation === "x402" || request.operation === "credit_topup") && !request.domain) {
      throw new TreasuryDeniedError("DOMAIN_REQUIRED", "x402 domain is required");
    }
  }

  private async getKnownCreditsBalance(): Promise<number> {
    let balance: number;
    try {
      balance = await this.conway.getCreditsBalance();
    } catch (error) {
      throw new TreasuryDeniedError(
        "BALANCE_UNKNOWN",
        `Credit balance is unknown; transfer denied: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Number.isSafeInteger(balance) || balance < 0) {
      throw new TreasuryDeniedError("BALANCE_UNKNOWN", "Credit balance response is invalid; transfer denied");
    }
    return balance;
  }

  private assertTransferLimits(amountCents: number, balanceCents: number): void {
    if (amountCents > this.policy.maxSingleTransferCents) {
      throw new TreasuryDeniedError("SINGLE_TRANSFER_LIMIT", "Transfer exceeds maximum single-transfer limit");
    }
    if (balanceCents - amountCents < this.policy.minimumReserveCents) {
      throw new TreasuryDeniedError("MINIMUM_RESERVE", "Transfer would violate the minimum credit reserve");
    }
    const hourly = this.sumSince("transfer", new Date(Date.now() - 3_600_000));
    const daily = this.sumSince("transfer", new Date(Date.now() - 86_400_000));
    if (hourly + amountCents > this.policy.maxHourlyTransferCents) {
      throw new TreasuryDeniedError("HOURLY_TRANSFER_LIMIT", "Transfer would exceed the hourly limit");
    }
    if (daily + amountCents > this.policy.maxDailyTransferCents) {
      throw new TreasuryDeniedError("DAILY_TRANSFER_LIMIT", "Transfer would exceed the daily limit");
    }
  }

  private assertPaymentLimits(request: TreasuryIntentRequest): void {
    if (request.amountCents > this.policy.maxX402PaymentCents) {
      throw new TreasuryDeniedError("X402_SINGLE_LIMIT", "x402 payment exceeds the configured maximum");
    }
    const hostname = request.domain!.toLowerCase();
    const allowed = this.policy.x402AllowedDomains.some((entry) => {
      const normalized = entry.toLowerCase();
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
    if (!allowed) {
      throw new TreasuryDeniedError("X402_DOMAIN_DENIED", `x402 domain is not allowlisted: ${hostname}`);
    }
    const hourly = this.sumSince("x402", new Date(Date.now() - 3_600_000));
    const daily = this.sumSince("x402", new Date(Date.now() - 86_400_000));
    if (hourly + request.amountCents > this.policy.maxX402PaymentCents * 10) {
      throw new TreasuryDeniedError("X402_HOURLY_LIMIT", "x402 payment would exceed the hourly budget");
    }
    if (daily + request.amountCents > this.policy.maxX402PaymentCents * 50) {
      throw new TreasuryDeniedError("X402_DAILY_LIMIT", "x402 payment would exceed the daily budget");
    }
  }

  private assertNoUnresolvedIntent(): void {
    const placeholders = ACTIVE_OR_UNCERTAIN.map(() => "?").join(",");
    const row = this.db.prepare(
      `SELECT id, status FROM treasury_intents WHERE status IN (${placeholders}) LIMIT 1`,
    ).get(...ACTIVE_OR_UNCERTAIN) as { id: string; status: string } | undefined;
    if (row) {
      throw new TreasuryDeniedError(
        "UNRESOLVED_FINANCIAL_INTENT",
        `Financial intent ${row.id} is ${row.status}; reconcile it before another payment`,
      );
    }
  }

  private insertIntent(request: TreasuryIntentRequest, balanceBefore: number | null): TreasuryAuthorization {
    const id = ulid();
    const idempotencyKey = request.idempotencyKey ?? ulid();
    const now = new Date().toISOString();
    try {
      this.db.prepare(
        `INSERT INTO treasury_intents
         (id, idempotency_key, operation, status, amount_cents, recipient, domain,
          balance_before_cents, created_at, updated_at)
         VALUES (?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        idempotencyKey,
        request.operation,
        request.amountCents,
        request.recipient ?? null,
        request.domain?.toLowerCase() ?? null,
        balanceBefore,
        now,
        now,
      );
    } catch (error) {
      throw new TreasuryDeniedError(
        "IDEMPOTENCY_CONFLICT",
        `Financial request cannot be reserved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { intentId: id, idempotencyKey };
  }

  private transition(
    intentId: string,
    from: TreasuryIntentStatus[],
    to: TreasuryIntentStatus,
    metadata?: Record<string, unknown>,
  ): void {
    const placeholders = from.map(() => "?").join(",");
    const result = this.db.prepare(
      `UPDATE treasury_intents SET status = ?, metadata = COALESCE(?, metadata), updated_at = ?
       WHERE id = ? AND status IN (${placeholders})`,
    ).run(to, metadata ? JSON.stringify(metadata) : null, new Date().toISOString(), intentId, ...from);
    if (result.changes !== 1) {
      throw new TreasuryDeniedError("INVALID_INTENT_STATE", `Invalid treasury transition for ${intentId}: ${from.join("|")} -> ${to}`);
    }
  }

  private settle(
    intentId: string,
    balanceAfter: number | null,
    metadata?: Record<string, unknown>,
    allowedFrom: TreasuryIntentStatus[] = ["reserved", "signed", "submitted"],
  ): void {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM treasury_intents WHERE id = ?").get(intentId) as IntentRow | undefined;
      if (!row || !allowedFrom.includes(row.status)) {
        throw new TreasuryDeniedError("INVALID_INTENT_STATE", `Treasury intent ${intentId} cannot settle from ${row?.status ?? "missing"}`);
      }
      this.db.prepare(
        `UPDATE treasury_intents
         SET status = 'settled', balance_after_cents = COALESCE(?, balance_after_cents),
             metadata = COALESCE(?, metadata), updated_at = ?, settled_at = ?
         WHERE id = ?`,
      ).run(balanceAfter, metadata ? JSON.stringify(metadata) : null, now, now, intentId);

      const category = row.operation === "credit_transfer" || row.operation === "child_funding"
        ? "transfer"
        : "x402";
      this.db.prepare(
        `INSERT INTO spend_tracking
         (id, tool_name, amount_cents, recipient, domain, category, window_hour, window_day, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        intentId,
        row.operation,
        row.amount_cents,
        row.recipient,
        row.domain,
        category,
        now.slice(0, 13),
        now.slice(0, 10),
        now,
      );
    });
    tx.immediate();
  }

  private sumSince(category: "transfer" | "x402", since: Date): number {
    const operations = category === "transfer"
      ? ["credit_transfer", "child_funding"]
      : ["x402", "credit_topup"];
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
       FROM treasury_intents
       WHERE operation IN (?, ?) AND status IN ('reserved', 'signed', 'submitted', 'settled', 'uncertain')
         AND created_at >= ?`,
    ).get(operations[0], operations[1], since.toISOString()) as { total: number };
    return row.total;
  }
}
