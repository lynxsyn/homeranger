/**
 * Shared worker error mapping for the M6 outreach jobs — mirrors the
 * inbound-handler.ts duck-typed `retryable` idiom. A `retryable === false`
 * error (a ComplianceError hard-block like PECR/OPTED_OUT/SUPPRESSED/KILL, or a
 * non-retryable OutreachError) becomes an UnrecoverableError so BullMQ DROPS the
 * job (no retry, no send, no row); anything else rethrows so the retry/backoff
 * runs (transient send errors + the retryable WARMUP_CAP_EXCEEDED / fail-closed
 * RATE_LIMIT_UNAVAILABLE). Unknown errors default to retryable (transient-safe).
 *
 * Logs carry the structured scope + ids ONLY — never email/body/token (PII).
 */
import { UnrecoverableError } from "bullmq";

export function isRetryable(error: unknown): boolean {
  const flag = (error as { retryable?: unknown } | null)?.retryable;
  return typeof flag === "boolean" ? flag : true;
}

export function toWorkerError(
  error: unknown,
  log: Record<string, unknown>,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (!isRetryable(error)) {
    console.error(
      JSON.stringify({
        type: "error",
        ...log,
        ...(typeof code === "string" ? { code } : {}),
        terminal: true,
        message,
      }),
    );
    return new UnrecoverableError(message);
  }
  return error instanceof Error ? error : new Error(message);
}
