/**
 * Pure discovery-recall helpers (M7 recall improvement) — UNIT-COVERED, NOT
 * coverage-excluded. These carry the whole recall logic; the Firecrawl provider
 * (firecrawl-agent-discovery.provider.ts) is a thin, operator-proven network
 * shell around them.
 *
 * Why a separate module: the original provider did ONE generic search query
 * ("estate agents in {region}, UK") + regex-extracted emails from the returned
 * markdown — so it missed small independents (the single query ranks toward big
 * aggregators) and any agency whose email is not plaintext on the fetched page.
 * The fan-out (multiple targeted queries) + the contact-page extraction in the
 * provider both lean on these pure functions, which are deterministic + tested.
 *
 * No network, no env reads in here — config is passed in as args. The provider
 * owns env + I/O.
 */
import type { DiscoveredAgent } from "./agent-discovery.provider.js";

/**
 * Any email-looking token in free text. Mirrors the original provider's EMAIL_RE,
 * moved here so the regex extraction is unit-covered (it carries recall logic).
 */
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** A sane upper bound on a real email length — longer matches are page noise. */
const MAX_EMAIL_LENGTH = 254; // RFC 5321 practical address limit

/** Default cap on the query fan-out (keeps Firecrawl spend bounded). */
export const DEFAULT_MAX_QUERIES = 6;

/**
 * Build the multi-query FAN-OUT for a region. The original single generic query
 * ranked toward big aggregators and missed small independents; fanning out across
 * "estate agents" / "letting agents" / "independent estate agents" / per-outcode
 * queries surfaces a much wider set of agencies.
 *
 * Order is stable + deterministic (best-recall queries first), deduped
 * case-insensitively, and bounded by `maxQueries` (default ~6). A blank region
 * falls back to outcode-only queries. Never emits an empty query.
 */
export function buildDiscoveryQueries(
  region: string,
  outcodes: string[],
  opts?: { maxQueries?: number },
): string[] {
  const cap = clampMaxQueries(opts?.maxQueries);
  const trimmedRegion = (region ?? "").trim();
  const candidates: string[] = [];

  if (trimmedRegion.length > 0) {
    candidates.push(`estate agents in ${trimmedRegion}, UK`);
    candidates.push(`letting agents in ${trimmedRegion}, UK`);
    candidates.push(`independent estate agents ${trimmedRegion} UK`);
  }

  // One per-outcode query (upper-cased), in input order, until the cap is hit.
  for (const raw of outcodes ?? []) {
    const code = (raw ?? "").trim().toUpperCase();
    if (code.length > 0) {
      candidates.push(`estate agents ${code} UK`);
    }
  }

  // Dedup case-insensitively, preserve first-seen order, never exceed the cap,
  // never emit an empty query.
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const query of candidates) {
    if (query.trim().length === 0) {
      continue;
    }
    const key = query.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    queries.push(query);
    if (queries.length >= cap) {
      break;
    }
  }
  return queries;
}

/** Clamp the requested fan-out cap to a sane positive integer. */
function clampMaxQueries(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_MAX_QUERIES;
  }
  const n = Math.floor(requested);
  return n >= 1 ? n : 1;
}

/**
 * Extract email addresses from free text (search-result markdown or a scraped
 * contact page). Lower-cased + deduped, bounded (ignore absurdly long matches),
 * dropping obvious non-agency noise (asset filenames mis-parsed as addresses).
 * Stable order (first-seen). Pure — moved here from the provider so it's tested.
 */
export function extractEmails(text: string): string[] {
  if (!text) {
    return [];
  }
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const match of text.matchAll(EMAIL_RE)) {
    const raw = match[0];
    if (raw.length > MAX_EMAIL_LENGTH) {
      continue; // page noise, not a real address
    }
    const email = stripLeadingPhoneDigits(raw.toLowerCase());
    if (email.startsWith("@") || isNoiseEmail(email)) {
      continue;
    }
    if (!seen.has(email)) {
      seen.add(email);
      emails.push(email);
    }
  }
  return emails;
}

/**
 * Strip a phone number fused onto the start of an email's local part — a
 * collapsed-source-text artifact (a directory PDF rendering "Tel 01492 640415
 * llanrwst@x" as "01492640415llanrwst@x", or "543111info@x"). Drops a LEADING
 * run of >=5 digits ONLY when immediately followed by a letter (digits-then-
 * letters = phone+name collision); a genuinely all-digit local part (rare but
 * valid) has no following letter and is untouched. Pure.
 */
function stripLeadingPhoneDigits(email: string): string {
  return email.replace(/^\d{5,}(?=[a-z])/, "");
}

/**
 * Tokens marking a result as a council / social-housing / DIRECTORY document
 * rather than a single estate agency — its emails are council teams, housing
 * associations, or a list of many agencies, NOT one agency to cold-email.
 */
const NON_AGENCY_SOURCE_RE =
  /\[pdf\]|\bcouncil\b|\bborough\b|landlord details|\bhomelessness\b|allocation policy|housing options|social (?:housing|landlord)|registered social landlord|\bmanaging agents\b|housing association/i;

/**
 * TRUE when a search/scrape result is a council / social-housing / directory page
 * (NOT a single estate agency) — the provider must NOT harvest its emails, or it
 * mints bogus "agents" (council teams + housing associations all stamped with the
 * document's title — the Conwy "Main Housing Landlord Details" PDF bug). High
 * precision: a .gov.uk host, or the title/url carrying an unambiguous
 * council/social-housing/directory token. Pure.
 */
export function isNonAgencyResult(result: {
  title?: string;
  metadata?: { title?: string };
  url?: string;
}): boolean {
  const host = hostnameOf(result.url);
  if (host && (host === "gov.uk" || host.endsWith(".gov.uk"))) {
    return true; // a local-authority site is never an estate agency
  }
  const haystack = `${result.title ?? ""} ${result.metadata?.title ?? ""} ${
    result.url ?? ""
  }`;
  return NON_AGENCY_SOURCE_RE.test(haystack);
}

/**
 * TRUE when an email plausibly belongs to an estate agency we may cold-email.
 * Rejects local-authority (.gov.uk) addresses — a council housing team is never
 * the right cold-outreach target. Belt-and-braces alongside isNonAgencyResult's
 * page-level skip. Pure.
 */
export function isLikelyAgencyEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at <= 0) {
    return false;
  }
  const domain = email.slice(at + 1).toLowerCase();
  return !(domain === "gov.uk" || domain.endsWith(".gov.uk"));
}

/**
 * Drop obvious non-contact tokens that the email regex mis-captures: an asset
 * filename embedded in markdown (e.g. `logo@2x.png`, `sprite@3x.jpg`) parses as a
 * pseudo-address but is never a real mailbox. Kept simple + safe — only the
 * unambiguous image/asset suffixes, never real TLDs.
 */
function isNoiseEmail(email: string): boolean {
  return /\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(email);
}

/** The lower-cased hostname of a URL, or undefined when absent/unparseable. */
export function hostnameOf(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Derive a human agency name for a search/scrape result, best-first:
 *   title → metadata.title → hostname → "Unknown agency".
 * Moved here from the provider (the original inline fallback chain) so it's
 * tested + reused by both the search-snippet path and the contact-page path.
 */
export function agencyNameFrom(result: {
  title?: string;
  metadata?: { title?: string };
  url?: string;
}): string {
  // A directory/document title (a council PDF, a "managing agents" index) is NOT
  // one agency's name — using it would stamp the SAME title on every email
  // harvested from that page. Reject it and fall back to the per-email hostname.
  const usable = (t?: string): string | undefined => {
    const trimmed = t?.trim();
    return trimmed && !NON_AGENCY_SOURCE_RE.test(trimmed) ? trimmed : undefined;
  };
  return (
    usable(result.title) ||
    usable(result.metadata?.title) ||
    hostnameOf(result.url) ||
    "Unknown agency"
  );
}

/**
 * Union + email-dedup a set of discovered agents (across the multi-query fan-out
 * and the two extraction paths). Emails are lower-cased + trimmed; the FIRST
 * agent seen for an email wins (stable), so a richer earlier record (with a
 * websiteUrl) is not overwritten by a barer later one. Malformed (no local-part
 * or no domain) addresses are dropped — the service classifies them `unknown`
 * anyway, but dropping here keeps the provider's contract clean.
 */
export function dedupeByEmail(agents: DiscoveredAgent[]): DiscoveredAgent[] {
  const byEmail = new Map<string, DiscoveredAgent>();
  for (const agent of agents) {
    const email = agent.email.trim().toLowerCase();
    const at = email.lastIndexOf("@");
    if (at <= 0 || at === email.length - 1 || !email.slice(at + 1).includes(".")) {
      continue; // malformed — skip
    }
    if (!byEmail.has(email)) {
      byEmail.set(email, { ...agent, email });
    }
  }
  return [...byEmail.values()];
}
