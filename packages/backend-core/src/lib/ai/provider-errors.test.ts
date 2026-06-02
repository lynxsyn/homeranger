/**
 * Unit tests for the shared provider-error classification. The load-bearing new
 * behaviour vs the original (extraction-only) classifier is the 404/405/410 →
 * TERMINAL rule (.aide/notes/extraction-404-non-retryable.md): a misconfigured
 * AI Gateway slug 404s, and must fail fast instead of burning every retry.
 */
import { describe, expect, it } from "vitest";
import {
  classifyProviderError,
  createNonRetryableError,
  getCode,
  getStatus,
  isProviderError,
  isRetryableStatus,
  type ProviderError,
} from "./provider-errors.js";

describe("isRetryableStatus", () => {
  it("treats 429 / 529 / 5xx as retryable", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(529)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });

  it("treats 400 / 401 / 403 as terminal", () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
  });

  it("treats 404 / 405 / 410 as terminal (misconfigured-gateway fast-fail)", () => {
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(405)).toBe(false);
    expect(isRetryableStatus(410)).toBe(false);
  });

  it("defaults an undefined or unlisted status to retryable (transient-safe)", () => {
    expect(isRetryableStatus(undefined)).toBe(true);
    expect(isRetryableStatus(418)).toBe(true);
  });
});

describe("classifyProviderError", () => {
  it("classifies a 404 from a provider as NON-retryable", () => {
    const err = classifyProviderError(
      Object.assign(new Error("not found"), { status: 404 }),
      "fallback",
    );
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(404);
  });

  it("classifies a 429 as retryable and a 400 as non-retryable", () => {
    expect(
      classifyProviderError(Object.assign(new Error("x"), { status: 429 }), "f")
        .retryable,
    ).toBe(true);
    expect(
      classifyProviderError(Object.assign(new Error("x"), { status: 400 }), "f")
        .retryable,
    ).toBe(false);
  });

  it("reads statusCode + code off the error", () => {
    const err = classifyProviderError(
      Object.assign(new Error("forbidden"), {
        statusCode: 403,
        code: "permission_denied",
      }),
      "f",
    );
    expect(err).toMatchObject({
      retryable: false,
      status: 403,
      code: "permission_denied",
    } as Partial<ProviderError>);
  });

  it("preserves an already-classified ProviderError unchanged", () => {
    const pre = createNonRetryableError("already typed");
    expect(classifyProviderError(pre, "f")).toBe(pre);
  });

  it("wraps a non-Error throw into a retryable provider error with the fallback", () => {
    const err = classifyProviderError("a string blew up", "wrapped fallback");
    expect(err).toBeInstanceOf(Error);
    expect(err.retryable).toBe(true);
    expect(err.message).toBe("wrapped fallback");
  });
});

describe("helpers", () => {
  it("createNonRetryableError sets retryable=false", () => {
    expect(createNonRetryableError("boom").retryable).toBe(false);
  });
  it("isProviderError narrows on the retryable boolean", () => {
    expect(isProviderError(createNonRetryableError("x"))).toBe(true);
    expect(isProviderError(new Error("plain"))).toBe(false);
    expect(isProviderError(null)).toBe(false);
  });
  it("getStatus / getCode return undefined for non-objects", () => {
    expect(getStatus(undefined)).toBeUndefined();
    expect(getCode(42)).toBeUndefined();
  });
});
