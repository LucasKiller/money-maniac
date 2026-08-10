/**
 * Resilient HTTP Client
 *
 * Shared HTTP client with timeouts, retries, jittered exponential backoff,
 * and circuit breaker for all outbound Conway API calls.
 *
 * Phase 1.3: Network Resilience (P1-8, P1-9)
 */

import type { HttpClientConfig } from "../types.js";
import { DEFAULT_HTTP_CLIENT_CONFIG } from "../types.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata.aws.internal"]);

function normalizedHostname(parsed: URL): string {
  return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isPrivateNetworkHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || METADATA_HOSTS.has(host)) return true;
  if (host.includes(":")) {
    const normalized = host.toLowerCase();
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc")
      || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9")
      || normalized.startsWith("fea") || normalized.startsWith("feb")
      || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:169.254.");
  }
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function assertSecureUrl(
  url: string,
  allowHttpOnLoopback: boolean,
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const protocol = parsed.protocol.toLowerCase();
  const host = normalizedHostname(parsed);
  if (protocol === "http:" && allowHttpOnLoopback && LOOPBACK_HOSTS.has(host)) {
    return;
  }

  if (protocol === "https:" && !isPrivateNetworkHost(host)) return;

  if (protocol === "https:") {
    throw new Error(`SSRF protection: refusing private or metadata host ${host}`);
  }

  throw new Error(
    `HTTPS required: refusing insecure URL ${url}. ` +
      "For local development, only loopback HTTP (localhost/127.0.0.1/::1) can be explicitly enabled.",
  );
}

export class CircuitOpenError extends Error {
  constructor(public readonly resetAt: number) {
    super(
      `Circuit breaker is open until ${new Date(resetAt).toISOString()}`,
    );
    this.name = "CircuitOpenError";
  }
}

export class ResilientHttpClient {
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private readonly config: HttpClientConfig;

  constructor(config?: Partial<HttpClientConfig>) {
    this.config = { ...DEFAULT_HTTP_CLIENT_CONFIG, ...config };
  }

  async request(
    url: string,
    options?: RequestInit & {
      timeout?: number;
      idempotencyKey?: string;
      retries?: number;
    },
  ): Promise<Response> {
    assertSecureUrl(url, this.config.allowHttpOnLoopback);

    if (this.isCircuitOpen()) {
      throw new CircuitOpenError(this.circuitOpenUntil);
    }

    const opts = options ?? {};
    const timeout = opts.timeout ?? this.config.baseTimeout;
    const maxRetries = opts.retries ?? this.config.maxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await this.fetchFollowingSafeRedirects(url, {
          ...opts,
          signal: controller.signal,
          redirect: "manual",
          headers: {
            ...opts.headers,
            ...(opts.idempotencyKey
              ? { "Idempotency-Key": opts.idempotencyKey }
              : {}),
          },
        }, this.config.allowHttpOnLoopback);
        clearTimeout(timer);

        // Count retryable HTTP errors toward circuit breaker, regardless of
        // whether we will actually retry. A server consistently returning 502
        // should eventually trip the circuit breaker.
        if (this.config.retryableStatuses.includes(response.status)) {
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= this.config.circuitBreakerThreshold) {
            this.circuitOpenUntil = Date.now() + this.config.circuitBreakerResetMs;
          }
          if (attempt < maxRetries) {
            await this.backoff(attempt);
            continue;
          }
          return response;
        }

        // Only reset failure counter on truly successful responses
        this.consecutiveFailures = 0;
        return response;
      } catch (error) {
        clearTimeout(timer);
        this.consecutiveFailures++;
        if (
          this.consecutiveFailures >= this.config.circuitBreakerThreshold
        ) {
          this.circuitOpenUntil =
            Date.now() + this.config.circuitBreakerResetMs;
        }
        if (attempt === maxRetries) throw error;
        await this.backoff(attempt);
      }
    }

    throw new Error("Unreachable");
  }

  private async fetchFollowingSafeRedirects(
    url: string,
    init: RequestInit,
    allowLoopbackHttp: boolean,
  ): Promise<Response> {
    let currentUrl = url;
    for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
      assertSecureUrl(currentUrl, allowLoopbackHttp);
      const response = await fetch(currentUrl, init);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      if (redirectCount === 5) throw new Error("Too many HTTP redirects");
      const method = (init.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        throw new Error("Refusing to redirect a mutating HTTP request");
      }
      currentUrl = new URL(location, currentUrl).toString();
    }
    throw new Error("Unreachable redirect state");
  }

  private async backoff(attempt: number): Promise<void> {
    const delay = Math.min(
      this.config.backoffBase *
        Math.pow(2, attempt) *
        (0.5 + Math.random()),
      this.config.backoffMax,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  isCircuitOpen(): boolean {
    return Date.now() < this.circuitOpenUntil;
  }

  resetCircuit(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }
}
