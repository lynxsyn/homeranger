/**
 * Inbound sender authentication (anti-spoofing).
 *
 * The Resend inbound webhook is signed by the FORWARDER (Resend). That Svix
 * signature proves the request came from Resend — it proves NOTHING about
 * whether the message's `From` header is genuine. The original sender's
 * SPF/DKIM verdicts (hydrated from the message Authentication-Results headers)
 * are the only signal for that. Those verdicts are DMARC-ALIGNED upstream: the
 * inbound hydrator downgrades a `pass` whose signing (`header.d=`) or envelope
 * (`smtp.mailfrom=`) domain does not align with the `From` domain, so a `pass`
 * reaching this predicate attests the `From` domain itself — a spoofer who
 * DKIM-signs as their OWN domain is downgraded to fail before it gets here.
 *
 * We therefore treat a sender as authenticated only on an AFFIRMATIVE pass and
 * refuse to let unauthenticated mail drive agent-keyed side effects (forging a
 * reply / advancing OutreachThread state). "Not a hard fail" (neutral / none /
 * unknown) is deliberately NOT enough — a domain that publishes no SPF/DKIM is
 * indistinguishable from a spoof of it, so it is treated as untrusted for a
 * trust-bearing action.
 *
 * DKIM is the stronger signal: it is cryptographic and survives forwarding,
 * whereas SPF legitimately breaks when mail is relayed. A DKIM pass alone is
 * therefore sufficient (an SPF softfail on forwarded-but-DKIM-signed mail is not
 * over-blocked).
 *
 * NOTE: opt-out (STOP/unsubscribe) is intentionally NOT gated by this — dropping
 * a genuine opt-out is a PECR/GDPR violation, so opt-out errs toward
 * over-suppression and only logs the unauthenticated case for visibility.
 */
import type { EmailAuthVerdict } from "@prisma/client";

export function isAuthenticatedSender(
  spfVerdict: EmailAuthVerdict,
  dkimVerdict: EmailAuthVerdict,
): boolean {
  return dkimVerdict === "pass" || spfVerdict === "pass";
}
