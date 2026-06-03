/**
 * Email-domain helpers shared by agent discovery (per-agency collapse) and the
 * ComplianceGuard per-domain cooldown. Pure + deterministic; the domain is the
 * registrable identity we treat as "one agency" for anti-spam purposes.
 *
 * NB: estate-agent contacts use their own org domain (info@fletcherpoole.com),
 * so the bare host after `@` IS the agency identity — no public-suffix parsing
 * is needed here (and free-webmail domains never reach these paths: the PECR
 * gate classifies them `individual` and blocks the send first).
 */

/**
 * The lower-cased domain of an email (the part after the LAST `@`), or null when
 * the address is malformed (no `@`, empty local-part, empty domain, or a domain
 * with no dot). Mirrors classifyMailboxType's malformed-address guard so the two
 * never disagree on what counts as a real domain.
 */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) {
    return null;
  }
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain.includes(".")) {
    return null;
  }
  return domain;
}

/**
 * The lower-cased local-part of an email (the part before the LAST `@`), or null
 * when malformed. Drives the "best mailbox per agency" pick at discovery.
 */
export function emailLocalPart(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) {
    return null;
  }
  return email.slice(0, at).trim().toLowerCase();
}
