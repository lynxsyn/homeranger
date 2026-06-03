/**
 * RFC 8058 one-click unsubscribe token (M6 AC#5). A keyed HMAC over the
 * recipient email + a fixed purpose, so a token for agent A can never suppress
 * agent B, and the link is unguessable without the server secret. Verification
 * is CONSTANT-TIME (timingSafeEqual) — mirrors lib/webhooks/svix-signature.ts.
 * Email is normalised to trim().toLowerCase() before signing AND verifying, so
 * casing never splits a token (the same single-point normalisation the
 * SuppressionEntry repo uses for the suppression key).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const PURPOSE = "unsubscribe";

function resolveSecret(explicit?: string): string {
  if (explicit) {
    return explicit;
  }
  const secret = process.env.UNSUBSCRIBE_TOKEN_SECRET?.trim();
  if (secret) {
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("UNSUBSCRIBE_TOKEN_SECRET is required in production");
  }
  // Dev/CI fallback — never used in prod (the guard above throws there).
  return "homeranger-dev-unsubscribe-secret";
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function signUnsubscribeToken(email: string, secret?: string): string {
  return createHmac("sha256", resolveSecret(secret))
    .update(`${PURPOSE}:${normaliseEmail(email)}`)
    .digest("base64url");
}

export function verifyUnsubscribeToken(
  email: string,
  token: string,
  secret?: string,
): boolean {
  const expected = signUnsubscribeToken(email, secret);
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(token, "utf8");
  // Length check first — timingSafeEqual throws on unequal lengths.
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}
