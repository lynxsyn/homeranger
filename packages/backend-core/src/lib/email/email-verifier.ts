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
import { NeverBounceEmailVerifier } from "./neverbounce-email-verifier.js";
import { ZeroBounceEmailVerifier } from "./zerobounce-email-verifier.js";

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
 * Map a NeverBounce v4 `result` to our verdict. NeverBounce probes from its OWN
 * reputable IPs, so (unlike our Spamhaus-PBL-listed cluster IP) it reliably
 * reaches recipient mailboxes. `valid` ⇒ deliverable; `invalid` ⇒ a confident
 * dead mailbox ⇒ undeliverable. Everything else — `catchall` (can't confirm),
 * `disposable`, `unknown` — stays sendable (`unknown`): never block on a maybe.
 *
 * NOTE: NeverBounce's OWN default guidance flags `disposable` as undeliverable
 * (its "safe to send" set is valid+catchall+unknown). We DELIBERATELY diverge —
 * a legitimate UK estate agency is vanishingly unlikely to use a throwaway inbox,
 * so if the classifier misfires on a real business address we stay sendable
 * rather than silently suppress it (fail-open, same rationale as catchall/unknown).
 * Real bounce → SuppressionEntry remains the final backstop.
 */
export function mapNeverBounceResult(result: string): EmailDeliverability {
  switch (result) {
    case "valid":
      return "deliverable";
    case "invalid":
      return "undeliverable";
    default:
      return "unknown";
  }
}

/**
 * Map a ZeroBounce v2 (status, sub_status) to our verdict. ZeroBounce probes
 * from reputable IPs and resolves more catch-alls than NeverBounce.
 *
 * CRUCIAL for homeranger: ZeroBounce flags AGENCY ROLE INBOXES (info@, sales@,
 * enquiries@) as status `do_not_mail` / sub_status `role_based` — but those are
 * EXACTLY the addresses we target, so a role-based result MUST stay sendable,
 * never blocked. We only flag `do_not_mail` undeliverable for the genuinely
 * toxic sub-statuses (disposable / toxic / global_suppression / possible_traps).
 *   valid                                    ⇒ deliverable
 *   invalid | spamtrap                       ⇒ undeliverable (dead / reputation harm)
 *   do_not_mail + toxic-substatus            ⇒ undeliverable
 *   do_not_mail + role_based / mx_forward / other ⇒ unknown (a role inbox we WANT,
 *       or a mail-relay routing config — neither is a dead mailbox)
 *   catch-all | unknown | abuse | other      ⇒ unknown (sendable; never block on a maybe)
 * Conservative: only CONFIDENT dead/toxic blocks; real bounce + complaint
 * suppression stay the backstop.
 */
export function mapZeroBounceResult(
  status: string,
  subStatus = "",
): EmailDeliverability {
  switch (status) {
    case "valid":
      return "deliverable";
    case "invalid":
    case "spamtrap":
      return "undeliverable";
    case "do_not_mail":
      return /disposable|toxic|global_suppression|possible_trap/.test(subStatus)
        ? "undeliverable"
        : "unknown";
    default:
      // catch-all, unknown, abuse, error, or anything unrecognised → sendable.
      return "unknown";
  }
}

/**
 * Select the verifier (HTTPS API providers probe from reputable IPs, so they
 * work where our in-house SMTP probe can't — this cluster IP is Spamhaus-PBL-
 * listed, so Outlook/Mimecast policy-block a direct probe):
 *   EMAIL_VERIFY_FAKE=1                 ⇒ deterministic fake (unit/integration/E2E)
 *   EMAIL_VERIFY_PROVIDER=zerobounce    ⇒ ZeroBounce v2 (best catch-all resolution
 *       + a recurring free tier — the default for homeranger)
 *   EMAIL_VERIFY_PROVIDER=neverbounce   ⇒ NeverBounce v4 (kept as a fallback)
 *   otherwise                           ⇒ the in-house SMTP probe (safe, but it
 *       returns mostly `unknown` from this IP — see smtp-email-verifier.ts).
 */
export function getEmailVerifier(): EmailVerifier {
  if (process.env.EMAIL_VERIFY_FAKE === "1") {
    return new FakeEmailVerifier();
  }
  const provider = (process.env.EMAIL_VERIFY_PROVIDER ?? "").toLowerCase();
  if (provider === "zerobounce") {
    return new ZeroBounceEmailVerifier();
  }
  if (provider === "neverbounce") {
    return new NeverBounceEmailVerifier();
  }
  return new SmtpEmailVerifier();
}
