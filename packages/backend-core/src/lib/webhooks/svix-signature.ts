/**
 * Svix webhook signature verification (Node `crypto`, zero runtime deps).
 *
 * Resend signs ALL its webhooks (inbound `email.received` + delivery/bounce/
 * complaint events) with Svix. The signing secret is `whsec_<base64>`. Svix
 * sends three headers; it ships them under TWO naming conventions depending on
 * the integration — the `svix-id`/`svix-timestamp`/`svix-signature` set and the
 * generic `webhook-id`/`webhook-timestamp`/`webhook-signature` aliases. We
 * accept BOTH (the alias is what Resend's "Standard Webhooks" mode emits).
 *
 * Algorithm (mirrors doxus-web svix-operational-webhook.route.ts):
 *   1. strip the `whsec_` prefix and base64-decode the secret to raw bytes;
 *   2. signed content = `${id}.${timestamp}.${rawBody}`;
 *   3. HMAC-SHA256 over the signed content with the decoded secret → base64;
 *   4. expected = `v1,<base64>`;
 *   5. the signature header is a SPACE-separated list of `v<ver>,<sig>` entries
 *      — match ANY in constant time (timingSafeEqual);
 *   6. replay guard: reject when |now - timestamp| > tolerance (300s).
 *
 * Hand-rolled over the `svix` / `resend` SDK because (a) it matches the
 * established Doxus convention (raw route + Node crypto, no SDK on the hot
 * path), (b) it keeps the prehandler synchronous + dependency-free, and (c) it
 * lets the route map the exact failure reasons to HTTP codes (400 missing / 401
 * bad sig / 408 stale). If a future milestone prefers an audited lib, swap the
 * body of verifySvixSignature for `new Webhook(secret).verify(rawBody, headers)`
 * — the route shape is unchanged.
 */
import crypto from "node:crypto";

/** Default Svix clock-skew tolerance — matches Doxus + Svix's own default. */
export const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 300;

/** Svix secrets are `whsec_<base64>` — strip the prefix, decode to raw bytes. */
export function decodeSvixSecret(secret: string): Buffer {
  const stripped = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  return Buffer.from(stripped, "base64");
}

export type SvixVerifyReason =
  | "missing_headers"
  | "invalid_secret"
  | "invalid_timestamp"
  | "stale_timestamp"
  | "signature_mismatch";

/**
 * Minimum decoded-secret length. A bare `whsec_` (or otherwise empty/near-empty
 * base64 body) decodes to 0 bytes; an HMAC with an empty/short key is valid but
 * trivially forgeable. Resend's real `whsec_` secrets decode to 24+ bytes, so a
 * 16-byte floor rejects only misconfigured secrets and never a genuine one.
 */
export const MIN_SVIX_SECRET_BYTES = 16;

export type SvixVerifyResult =
  | { ok: true }
  | { ok: false; reason: SvixVerifyReason };

export interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

type HeaderBag = Record<string, string | string[] | undefined>;

function headerValue(
  headers: HeaderBag,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Extract the Svix headers from a Fastify/Node header bag, accepting BOTH the
 * `svix-*` naming and the `webhook-*` Standard-Webhooks aliases.
 */
export function extractSvixHeaders(headers: HeaderBag): SvixHeaders {
  return {
    id: headerValue(headers, "svix-id", "webhook-id"),
    timestamp: headerValue(headers, "svix-timestamp", "webhook-timestamp"),
    signature: headerValue(headers, "svix-signature", "webhook-signature"),
  };
}

/**
 * Verify a Svix-signed webhook. `rawBody` MUST be the exact bytes received —
 * any re-serialisation of parsed JSON breaks the signature.
 */
export function verifySvixSignature(
  rawBody: Buffer,
  headers: SvixHeaders,
  secret: string,
  nowMs: number = Date.now(),
): SvixVerifyResult {
  const { id, timestamp, signature } = headers;
  if (
    typeof id !== "string" ||
    typeof timestamp !== "string" ||
    typeof signature !== "string"
  ) {
    return { ok: false, reason: "missing_headers" };
  }

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - ts) > SVIX_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const decodedSecret = decodeSvixSecret(secret);
  // A 0-byte (bare `whsec_`/empty) or otherwise too-short secret decodes to a
  // weak HMAC key that an attacker could forge against — fail CLOSED rather than
  // computing an HMAC with an empty key.
  if (decodedSecret.length < MIN_SVIX_SECRET_BYTES) {
    return { ok: false, reason: "invalid_secret" };
  }
  const signedContent = `${id}.${timestamp}.${rawBody.toString("utf8")}`;
  const expected = `v1,${crypto
    .createHmac("sha256", decodedSecret)
    .update(signedContent)
    .digest("base64")}`;
  const expectedBuf = Buffer.from(expected);

  // The header may carry multiple space-separated `v1,<sig>` entries.
  for (const candidate of signature.split(" ")) {
    const candidateBuf = Buffer.from(candidate);
    if (
      candidateBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(candidateBuf, expectedBuf)
    ) {
      return { ok: true };
    }
  }

  return { ok: false, reason: "signature_mismatch" };
}

/**
 * Compute the Svix `v1,<sig>` signature for the given body/id/timestamp. Used by
 * tests (and the E2E spec) to sign a payload with a known `whsec_` secret. NOT
 * called on the verification hot path.
 */
export function signSvixPayload(
  rawBody: string,
  id: string,
  timestamp: string,
  secret: string,
): string {
  const decodedSecret = decodeSvixSecret(secret);
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  return `v1,${crypto
    .createHmac("sha256", decodedSecret)
    .update(signedContent)
    .digest("base64")}`;
}
