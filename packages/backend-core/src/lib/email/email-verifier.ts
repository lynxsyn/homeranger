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
 * permanent reject that names a NON-EXISTENT MAILBOX (see classifyRcptReply).
 * `unknown` — everything we cannot confidently call dead: a catch-all domain
 * (2xx for everything), a policy/IP/reputation block (e.g. our probe IP on the
 * Spamhaus PBL — the mailbox is likely fine), a 4xx greylist/temp failure, an
 * ambiguous bare 5xx, no MX, a timeout, or port 25 blocked. Only `undeliverable`
 * is blocked at send time; `unknown` stays sendable (we never exclude on a maybe).
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
 * Map an SMTP RCPT-TO reply (basic code + full text) to a deliverability verdict.
 *
 * 2xx ⇒ deliverable. For a 5xx we MUST split a MAILBOX rejection (the user does
 * not exist — safe to flag undeliverable) from a POLICY/IP rejection (the
 * recipient server blocked OUR probe IP — the mailbox may be perfectly live).
 * This matters because a self-hosted probe IP is routinely Spamhaus-PBL-listed,
 * so Outlook/Mimecast answer `550 5.7.1 ... blocked using Spamhaus` for VALID
 * mailboxes — a real send from Resend's reputable IP still delivers. Treating
 * that as dead would wrongly suppress most agencies (observed: 69% false vs ~30%
 * real bounce). So:
 *   - policy/IP/reputation 5xx (enhanced 5.7.x, or spamhaus/blocklist/policy/
 *     rate-limit/temporary text) ⇒ unknown (sendable; real send still delivers)
 *   - mailbox-nonexistence 5xx (enhanced 5.1.x addressing class, or "user
 *     unknown" / "no such user" / "mailbox unavailable|not found|does not exist"
 *     / "recipient|address rejected" / "invalid recipient" / "no mailbox") ⇒
 *     undeliverable
 *   - anything else (ambiguous bare 5xx, 4xx greylist/temp, no code) ⇒ unknown
 * Conservative by design: when in doubt return `unknown` and let the real
 * bounce → SuppressionEntry path be the authoritative dead-address gate.
 */
export function classifyRcptReply(
  code: number | null,
  text = "",
): EmailDeliverability {
  if (code !== null && Number.isFinite(code) && code >= 200 && code < 300) {
    return "deliverable";
  }
  // 4xx greylist/temp, no code, or any non-permanent reply → can't decide.
  if (code === null || !Number.isFinite(code) || code < 500) {
    return "unknown";
  }
  const t = text.toLowerCase();
  const enhanced = /\b5\.(\d+)\.\d+\b/.exec(text);
  const klass = enhanced ? Number(enhanced[1]) : null;
  // Policy / IP / reputation reject — checked FIRST (a 5.7.x "rejected" is a
  // block, not a dead mailbox). NOT a deliverability signal → stay sendable.
  if (
    klass === 7 ||
    /spamhaus|block ?list|black ?list|\bpbl\b|\brbl\b|\bdnsbl\b|reputation|policy|access denied|not allowed|rate ?limit|too many|temporar|greylist|gray ?list|deferred|try again/.test(
      t,
    )
  ) {
    return "unknown";
  }
  // Mailbox does not exist — the only case safe to flag undeliverable.
  if (
    klass === 1 ||
    /user unknown|unknown user|no such user|no such recipient|user not found|recipient not found|mailbox (unavailable|not found|does ?n.?t exist|is disabled|disabled)|(recipient|address)[^.]*reject|invalid (recipient|mailbox|address)|no mailbox|does ?not exist|account (is )?(disabled|unavailable)/.test(
      t,
    )
  ) {
    return "undeliverable";
  }
  // Ambiguous permanent failure → conservative; rely on real-bounce suppression.
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
