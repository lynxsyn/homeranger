/**
 * ZeroBounce email-verification adapter (network — coverage-excluded in
 * vitest.config.ts, like the other provider shells). Calls the ZeroBounce v2
 * /validate API over HTTPS (:443, already allowed). ZeroBounce probes from its
 * OWN reputable IPs (so it works where our Spamhaus-PBL-listed cluster IP can't),
 * resolves more catch-alls than NeverBounce, and has a recurring free tier that
 * covers homeranger's volume. Selected when EMAIL_VERIFY_PROVIDER=zerobounce.
 *
 * Fail-open: a missing key, network/timeout error, non-2xx, or an error payload
 * without a string `status` (e.g. insufficient credits / invalid key) all resolve
 * to "unknown" (sendable) — a verification outage must never suppress outreach.
 * Never sends mail. The pure (status, sub_status)→verdict mapping
 * (mapZeroBounceResult) lives in email-verifier.ts + is unit-tested; this module
 * owns only the HTTP call.
 */
import {
  mapZeroBounceResult,
  type EmailDeliverability,
  type EmailVerifier,
} from "./email-verifier.js";

function intEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface ZeroBounceEmailVerifierOptions {
  apiKey?: string;
  timeoutMs?: number;
  baseUrl?: string;
}

export class ZeroBounceEmailVerifier implements EmailVerifier {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(opts: ZeroBounceEmailVerifierOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ZEROBOUNCE_API_KEY ?? "";
    this.timeoutMs =
      opts.timeoutMs ?? intEnv("EMAIL_VERIFY_TIMEOUT_MS", 10_000);
    this.baseUrl =
      opts.baseUrl ??
      (process.env.ZEROBOUNCE_BASE_URL || "https://api.zerobounce.net");
  }

  async verify(email: string): Promise<EmailDeliverability> {
    if (!this.apiKey) {
      return "unknown";
    }
    try {
      const url =
        `${this.baseUrl.replace(/\/$/, "")}/v2/validate` +
        `?api_key=${encodeURIComponent(this.apiKey)}` +
        `&email=${encodeURIComponent(email.trim())}` +
        `&ip_address=`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        return "unknown";
      }
      const data = (await response.json()) as {
        status?: string;
        sub_status?: string;
      };
      // Error payloads (insufficient credits / bad key) lack a string status.
      if (typeof data.status !== "string") {
        return "unknown";
      }
      return mapZeroBounceResult(
        data.status,
        typeof data.sub_status === "string" ? data.sub_status : "",
      );
    } catch {
      return "unknown";
    }
  }
}
