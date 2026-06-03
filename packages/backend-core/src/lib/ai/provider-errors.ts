/**
 * Shared retryable-vs-terminal error classification for the homeranger AI
 * providers (Claude extraction, Claude vision, Voyage embedding, Claude match
 * re-score). Extracted from `claude-extraction.provider.ts` so EVERY provider
 * classifies HTTP failures identically and the BullMQ retry decision (honoured
 * by the worker handlers via the `retryable` flag) is consistent across the
 * analyse pipeline.
 *
 * Classification by HTTP status (PR #17 semantics, generalised to every AI provider):
 *   - 408 / 429 / 5xx (incl. 529 overloaded) → RETRYABLE (timeout / rate limit / transient)
 *   - any OTHER 4xx (400/401/403/404/405/409/410/…) → TERMINAL: a client error that
 *     never succeeds on retry. 404 in particular catches a misconfigured/renamed
 *     AI Gateway slug whose URL 404s — failing fast turns that into one dropped
 *     job instead of burning the whole BullMQ attempt budget + backoff.
 *   - undefined / non-4xx-non-5xx → RETRYABLE (network/unknown — transient-safe).
 *
 * This carries forward .aide/notes/extraction-404-non-retryable.md AND PR #17
 * (which widened the rule from a fixed terminal set to "all 4xx except 408").
 */

/** A provider error carrying the retry decision + the originating HTTP status. */
export interface ProviderError extends Error {
  retryable: boolean;
  status?: number;
  code?: string;
}

export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) {
    return true; // network / unknown transport error — retry
  }
  // Transient: request timeout (408), rate limit (429), Anthropic "overloaded"
  // (529) and any other 5xx — retry these.
  if (status === 408 || status === 429 || status >= 500) {
    return true;
  }
  // Every OTHER 4xx is a terminal client error (bad request / auth / 404 from a
  // misconfigured gateway / 405 / 410 / …) — fail fast, do not retry.
  if (status >= 400) {
    return false;
  }
  return true; // non-error / unexpected — retry defensively
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
