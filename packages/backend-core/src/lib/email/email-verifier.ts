/**
 * Email deliverability verification. Discovery probes every scraped address
 * before an agent becomes sendable; a confident hard reject flags the agent
 * `undeliverable` so the ComplianceGuard never bounces it. Motivation: ~30% of
 * scraped info@/contact@ addresses were dead, hard-bouncing and eroding the
 * homeranger.app sender reputation (the breaker trips at >2% over 50 sends).
 *
 * This module owns the TYPES, the pure SMTP-reply→verdict mapping, the
 * deterministic FAKE (selected by EMAIL_VERIFY_FAKE=1 so unit/integration/E2E
 * never open port 25), and the factory. The real socket conversation lives in
 * the coverage-excluded smtp-email-verifier.ts (a network adapter).
 */
import { SmtpEmailVerifier } from "./smtp-email-verifier.js";

/**
 * `deliverable` — the MX accepted the recipient (2xx). `undeliverable` — a
 * permanent mailbox reject (550/551/553/554). `unknown` — anything we cannot
 * confidently call dead: a catch-all domain (2xx for everything, indistinguish-
 * able and therefore treated as deliverable-and-sendable), a 4xx greylist/temp
 * failure, no MX, a timeout, or port 25 blocked. Only `undeliverable` is blocked
 * at send time; `unknown` stays sendable (we never exclude on a maybe).
 */
export type EmailDeliverability = "unknown" | "deliverable" | "undeliverable";

export interface EmailVerifier {
  /**
   * Probe one address. NEVER throws — a transport/probe failure resolves to
   * "unknown" (fail-open: we only ever BLOCK a confirmed-dead address, so a
   * probe outage must not silently suppress legitimate outreach).
   */
  verify(email: string): Promise<EmailDeliverability>;
}

/**
 * Map an SMTP RCPT-TO reply code to a deliverability verdict. 2xx ⇒ accepted ⇒
 * deliverable (a catch-all domain also lands here — sendable, which is the
 * intended treatment). 550/551/553/554 ⇒ permanent mailbox reject ⇒
 * undeliverable. Everything else — 4xx greylist/temp, 552 (mailbox full, not a
 * non-existent user), or a missing code — is `unknown` (still sendable).
 */
export function classifyRcptCode(code: number | null): EmailDeliverability {
  if (code === null || !Number.isFinite(code)) {
    return "unknown";
  }
  if (code >= 200 && code < 300) {
    return "deliverable";
  }
  if (code === 550 || code === 551 || code === 553 || code === 554) {
    return "undeliverable";
  }
  return "unknown";
}

/**
 * Deterministic verifier for unit/integration/E2E. The local-part drives the
 * verdict so a test (or seed) can assert each branch without a network: a
 * local-part containing bounce/dead/invalid/nouser ⇒ undeliverable;
 * catchall/greylist/unverif ⇒ unknown; otherwise deliverable.
 */
export class FakeEmailVerifier implements EmailVerifier {
  async verify(email: string): Promise<EmailDeliverability> {
    const local = (email.split("@")[0] ?? "").toLowerCase();
    if (/bounce|dead|invalid|nouser|noexist/.test(local)) {
      return "undeliverable";
    }
    if (/catchall|greylist|unverif/.test(local)) {
      return "unknown";
    }
    return "deliverable";
  }
}

/**
 * Select the verifier. EMAIL_VERIFY_FAKE=1 ⇒ the deterministic fake (tests/CI,
 * and prod until the operator is ready to probe); otherwise the real SMTP
 * verifier. Mirrors the other env-gated fake seams (RESEND_FAKE, DISCOVERY_FAKE…).
 */
export function getEmailVerifier(): EmailVerifier {
  if (process.env.EMAIL_VERIFY_FAKE === "1") {
    return new FakeEmailVerifier();
  }
  return new SmtpEmailVerifier();
}
