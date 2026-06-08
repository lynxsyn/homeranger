/**
 * Inbound recipient gate. The apex MX (homeranger.app) routes EVERY message for
 * the domain to Resend inbound -> our /webhooks/resend/inbound handler, not just
 * agent replies: DMARC RUA aggregate reports land at dmarc@homeranger.app (the
 * rua= address), bounce/abuse notifications at postmaster@/mailer-daemon@, etc.
 * Those are never an agent reply or a listing-bearing email, yet the handler
 * would otherwise hydrate them (fetch the .xml.gz attachment) and bill Claude to
 * "extract a listing" from a DMARC report.
 *
 * So we drop mail whose recipients are ALL infra/role local-parts BEFORE the
 * paid hydrate + extract. This is a RECIPIENT-based gate, NOT a sender check:
 * the product deliberately ingests listings from generic, non-agent senders, so
 * gating on the sender would wrongly drop real listing mail (a regression caught
 * by the e2e in PR #111). Real agent replies and listing emails arrive at a real
 * inbox (bryan@, inbox@), never at dmarc@. Parse misses fail OPEN — a recipient
 * we cannot parse is treated as deliverable so a real reply is never dropped on
 * a parse miss; only a POSITIVELY infra-only recipient set is dropped.
 */

/**
 * Role / infrastructure mailbox local-parts that are never a human outreach
 * inbox. Lower-cased; matched exactly against the recipient local-part.
 */
export const INFRA_RECIPIENT_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "dmarc",
  "postmaster",
  "abuse",
  "mailer-daemon",
  "bounce",
  "bounces",
  "noreply",
  "no-reply",
]);

/**
 * The lower-cased local-part of a recipient header value, accepting both a bare
 * address (`a@b`) and a display-name address (`Name <a@b>`). Returns null when
 * unparseable (no `@`, or an empty local-part).
 */
export function recipientLocalPart(addr: string): string | null {
  const angle = /<([^>]+)>/.exec(addr);
  const bare = (angle ? angle[1] : addr).trim();
  const at = bare.lastIndexOf("@");
  if (at <= 0) {
    return null;
  }
  return bare.slice(0, at).trim().toLowerCase();
}

/**
 * True if AT LEAST ONE recipient is a real (non-infra) inbox. Inbound mail with
 * no deliverable recipient (e.g. only dmarc@) is dropped pre-hydration. An empty
 * recipient list is not deliverable (anomalous, never a real reply); an
 * unparseable recipient fails OPEN (counts as deliverable).
 */
export function hasDeliverableRecipient(to: readonly string[]): boolean {
  return to.some((addr) => {
    const localPart = recipientLocalPart(addr);
    return localPart === null || !INFRA_RECIPIENT_LOCAL_PARTS.has(localPart);
  });
}
