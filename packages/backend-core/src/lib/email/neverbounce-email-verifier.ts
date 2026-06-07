/**
 * NeverBounce email-verification adapter (network — coverage-excluded in
 * vitest.config.ts, like smtp-email-verifier.ts). Calls the NeverBounce v4
 * single-check API over HTTPS (:443, already allowed from the processor), so the
 * deliverability probe runs from NeverBounce's REPUTABLE IPs rather than our
 * Spamhaus-PBL-listed cluster IP (which Outlook/Mimecast policy-block). Selected
 * when EMAIL_VERIFY_PROVIDER=neverbounce.
 *
 * Fail-open by design: a missing key, network/timeout error, non-2xx, or a
 * non-`success` app status all resolve to "unknown" (sendable) — a verification
 * outage must never silently suppress legitimate outreach. It NEVER sends mail.
 * The pure result→verdict mapping (mapNeverBounceResult) lives in email-verifier.ts
 * and is unit-tested; this module owns only the HTTP call.
 */
import {
  mapNeverBounceResult,
  type EmailDeliverability,
  type EmailVerifier,
} from "./email-verifier.js";

function intEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface NeverBounceEmailVerifierOptions {
  apiKey?: string;
  timeoutMs?: number;
  baseUrl?: string;
}

export class NeverBounceEmailVerifier implements EmailVerifier {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(opts: NeverBounceEmailVerifierOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.NEVERBOUNCE_API_KEY ?? "";
    this.timeoutMs =
      opts.timeoutMs ?? intEnv("EMAIL_VERIFY_TIMEOUT_MS", 10_000);
    this.baseUrl =
      opts.baseUrl ??
      (process.env.NEVERBOUNCE_BASE_URL || "https://api.neverbounce.com");
  }

  async verify(email: string): Promise<EmailDeliverability> {
    if (!this.apiKey) {
      // Not configured yet (key not in the cluster secret) → fail-open.
      return "unknown";
    }
    try {
      const url =
        `${this.baseUrl.replace(/\/$/, "")}/v4/single/check` +
        `?key=${encodeURIComponent(this.apiKey)}` +
        `&email=${encodeURIComponent(email.trim())}` +
        `&address_info=0&credits_info=0` +
        `&timeout=${Math.max(1, Math.round(this.timeoutMs / 1000))}`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        return "unknown";
      }
      const data = (await response.json()) as {
        status?: string;
        result?: string;
      };
      // NeverBounce returns app-level failures (auth_failure, throttle_triggered,
      // …) inside a 200 with status!="success" — only an explicit success counts.
      if (data.status !== "success" || typeof data.result !== "string") {
        return "unknown";
      }
      return mapNeverBounceResult(data.result);
    } catch {
      return "unknown";
    }
  }
}
