/**
 * Shared retryable-vs-terminal error classification for the homescout AI
 * providers (Claude extraction, Claude vision, Voyage embedding, Claude match
 * re-score). Extracted from `claude-extraction.provider.ts` so EVERY provider
 * classifies HTTP failures identically and the BullMQ retry decision (honoured
 * by the worker handlers via the `retryable` flag) is consistent across the
 * analyse pipeline.
 *
 * Classification by HTTP status:
 *   - 429 / 529 / 5xx                 → RETRYABLE (rate limit / overload / transient)
 *   - 400 / 401 / 403 / 404 / 405 / 410 → TERMINAL (bad request / auth / a
 *     missing-or-renamed endpoint — e.g. a misconfigured AI Gateway slug — which
 *     would otherwise burn every BullMQ attempt on a permanent error)
 *   - undefined / anything else       → RETRYABLE (transient-safe default)
 *
 * The 404/405/410 → terminal rule folds in the live-edge adversarial-review
 * follow-up (.aide/notes/extraction-404-non-retryable.md): if the AI Gateway env
 * is ever pointed at a missing/renamed gateway every call would 404 and, under
 * the old "unknown status → retryable" fall-through, exhaust attempts + re-bill
 * on a permanent error. Failing fast turns that into a single dropped job.
 */

/** A provider error carrying the retry decision + the originating HTTP status. */
export interface ProviderError extends Error {
  retryable: boolean;
  status?: number;
  code?: string;
}

/**
 * HTTP statuses that are TERMINAL (non-retryable): malformed request, auth, and
 * missing/renamed endpoints. Everything not listed here (and a missing status)
 * defaults to retryable — the transient-safe choice.
 */
const TERMINAL_STATUSES = new Set([400, 401, 403, 404, 405, 410]);

export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) {
    return true;
  }
  if (status === 429 || status === 529 || status >= 500) {
    return true;
  }
  if (TERMINAL_STATUSES.has(status)) {
    return false;
  }
  return true;
}

/** A typed error with `retryable: false` for parse failures / programming bugs. */
export function createNonRetryableError(message: string): ProviderError {
  const error = new Error(message) as ProviderError;
  error.retryable = false;
  return error;
}

export function isProviderError(error: unknown): error is ProviderError {
  return (
    error instanceof Error &&
    "retryable" in error &&
    typeof (error as ProviderError).retryable === "boolean"
  );
}

export function getStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  if ("status" in error && typeof (error as { status: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  if (
    "statusCode" in error &&
    typeof (error as { statusCode: unknown }).statusCode === "number"
  ) {
    return (error as { statusCode: number }).statusCode;
  }
  return undefined;
}

export function getCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
}

/**
 * Classify an arbitrary thrown value into a `ProviderError`. An already-typed
 * `ProviderError` is returned unchanged (so a deliberately-classified
 * non-retryable parse error is never reclassified). Otherwise the HTTP
 * status/code are read off the error and `retryable` is derived from the status.
 */
export function classifyProviderError(
  error: unknown,
  fallbackMessage: string,
): ProviderError {
  if (isProviderError(error)) {
    return error;
  }

  const status = getStatus(error);
  const code = getCode(error);
  const retryable = isRetryableStatus(status);

  const providerError = (
    error instanceof Error ? error : new Error(fallbackMessage)
  ) as ProviderError;
  providerError.retryable = retryable;
  if (status !== undefined) {
    providerError.status = status;
  }
  if (code !== undefined) {
    providerError.code = code;
  }
  return providerError;
}
