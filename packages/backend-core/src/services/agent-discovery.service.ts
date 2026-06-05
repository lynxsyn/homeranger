/**
 * AgentDiscoveryService (M7) — resolves a UK region to outcodes, asks the
 * AgentDiscoveryProvider for estate agents there, classifies + dedups them, and
 * upserts them as Agents ready for the existing ComplianceGuard-gated outreach.
 *
 * Discovery only SOURCES; it never sends. Classification sets mailboxType so the
 * guard's PECR gate (corporate_subscriber only) decides who is cold-emailable.
 * A free-mail / personal mailbox (gmail/outlook/etc.) is DROPPED at discovery:
 * it is not a corporate subscriber, so it could never be cold-emailed anyway and
 * would only sit in the table as unsendable dead weight. Only corporate agents
 * are persisted, each with a website (scraped, else derived from the domain) so
 * the operator can verify the agency before outreach.
 *
 * Variant-B lazy singleton (the provider is a required injected network client).
 */
import type { MailboxType } from "@prisma/client";
import {
  agentRepository as defaultAgentRepository,
  type AgentRepository,
} from "../repositories/agent.repository.js";
import {
  suppressionEntryRepository as defaultSuppressionEntryRepository,
  type SuppressionEntryRepository,
} from "../repositories/suppression-entry.repository.js";
import { resolveLocationToOutcodes } from "../lib/geo/uk-locations.js";
import { emailDomain, emailLocalPart } from "../lib/email/email-domain.js";
import type { AgentDiscoveryProvider } from "../lib/discovery/agent-discovery.provider.js";

/** Free webmail domains — a mailbox here is `individual` (PECR: not cold-emailable). */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "live.co.uk",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "aol.com",
  "msn.com",
  "btinternet.com",
  "btopenworld.com",
  "sky.com",
  "virginmedia.com",
  "virgin.net",
  "blueyonder.co.uk",
  "ntlworld.com",
  "talktalk.net",
  "tiscali.co.uk",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "gmx.com",
  "gmx.co.uk",
  "gmx.net",
  "zoho.com",
  "fastmail.com",
  "fastmail.co.uk",
  "mail.com",
  "ymail.com",
  "rocketmail.com",
  "hey.com",
  "yandex.com",
]);

/**
 * Classify a mailbox for the PECR gate: a free-webmail domain ⇒ `individual`
 * (never cold-emailed); a business/agency domain ⇒ `corporate_subscriber`; a
 * malformed address ⇒ `unknown` (also not cold-emailed). Pure + tested.
 */
export function classifyMailboxType(email: string): MailboxType {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) {
    return "unknown";
  }
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain.includes(".")) {
    return "unknown";
  }
  return FREE_MAIL_DOMAINS.has(domain) ? "individual" : "corporate_subscriber";
}

/**
 * The agency website to store for a discovered agent: the provider's scraped
 * `websiteUrl` when it gave one, otherwise `https://<email-domain>` so the
 * operator always has a link to click through and verify the agency before
 * outreach. Returns null only for a malformed address (no real domain) — which
 * never reaches the upsert path (corporate agents always have a domain). Pure.
 */
export function agentWebsite(email: string, websiteUrl?: string): string | null {
  const scraped = websiteUrl?.trim();
  if (scraped) {
    return scraped;
  }
  const domain = emailDomain(email);
  return domain ? `https://${domain}` : null;
}

/** Generic agency inboxes, best-first — preferred over a named person's mailbox. */
const GENERIC_LOCALPARTS = [
  "info",
  "hello",
  "enquiries",
  "enquiry",
  "sales",
  "office",
  "contact",
  "admin",
  "mail",
  "team",
];

/**
 * Pick the ONE mailbox to keep for an agency (a set of same-domain emails), so a
 * 3-inbox agency (conwy@/lettings@/rhos@ at fletcherpoole.com) becomes a single
 * cold contact. Priority, best-first:
 *   1. a local-part matching the search location (e.g. "conwy@" for a Conwy
 *      search) — most likely the relevant branch.
 *   2. a generic agency inbox (info@/hello@/enquiries@/sales@…) — reaches the
 *      agency rather than one named person.
 *   3. the shortest local-part (tie-break toward the simplest address).
 *   4. first seen (stable).
 * `emails` are same-domain, already lower-cased + deduped; never empty.
 */
export function pickBestEmail(emails: string[], regionLabel: string): string {
  const tokens = (regionLabel ?? "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 3);
  const rank = (email: string): { loc: number; gen: number; len: number } => {
    const local = emailLocalPart(email) ?? email;
    const loc = tokens.some((t) => local.includes(t)) ? 0 : 1;
    const gi = GENERIC_LOCALPARTS.indexOf(local);
    return { loc, gen: gi === -1 ? GENERIC_LOCALPARTS.length : gi, len: local.length };
  };
  return emails.reduce((best, cur) => {
    const b = rank(best);
    const c = rank(cur);
    if (c.loc !== b.loc) return c.loc < b.loc ? cur : best;
    if (c.gen !== b.gen) return c.gen < b.gen ? cur : best;
    if (c.len !== b.len) return c.len < b.len ? cur : best;
    return best; // full tie — keep the earlier (stable)
  });
}

export interface AgentDiscoveryResult {
  /** Candidates returned by the provider. */
  discovered: number;
  /** Candidates upserted as Agents (corporate subscribers only). */
  upserted: number;
  /** Candidates skipped (intra-batch dupe / malformed / free-mail / suppressed). */
  skipped: number;
  /** Extra same-agency mailboxes dropped by per-domain collapse (kept one each). */
  collapsed: number;
}

export interface AgentDiscoveryService {
  discoverRegion(regionName: string): Promise<AgentDiscoveryResult>;
  /**
   * Discover by an EXPLICIT outcode set (PR3 search-launch path) — the same
   * provider→classify→dedup→skip-suppressed→upsert pipeline as discoverRegion,
   * but skipping the region→outcode resolution. `regionLabel` (the search's
   * place name, e.g. "Conwy County") drives the provider's web-search query —
   * a search for the raw outcodes finds nothing. Blank/empty ⇒ a no-op result.
   */
  discoverByOutcodes(
    outcodes: string[],
    regionLabel?: string,
  ): Promise<AgentDiscoveryResult>;
}

export interface AgentDiscoveryDependencies {
  provider: AgentDiscoveryProvider;
  agentRepository?: AgentRepository;
  suppressionEntryRepository?: SuppressionEntryRepository;
}

export class DefaultAgentDiscoveryService implements AgentDiscoveryService {
  private readonly provider: AgentDiscoveryProvider;
  private readonly agentRepository: AgentRepository;
  private readonly suppressionEntryRepository: SuppressionEntryRepository;

  constructor(deps: AgentDiscoveryDependencies) {
    this.provider = deps.provider;
    this.agentRepository = deps.agentRepository ?? defaultAgentRepository;
    this.suppressionEntryRepository =
      deps.suppressionEntryRepository ?? defaultSuppressionEntryRepository;
  }

  async discoverRegion(regionName: string): Promise<AgentDiscoveryResult> {
    const outcodes = resolveLocationToOutcodes(regionName);
    if (outcodes.length === 0) {
      // Unsupported/blank region — nothing to target, never an error.
      console.info(
        JSON.stringify({
          type: "info",
          scope: "discovery.region.unsupported",
          region: regionName,
        }),
      );
      return { discovered: 0, upserted: 0, skipped: 0, collapsed: 0 };
    }
    return this.runDiscovery({ region: regionName, outcodes });
  }

  async discoverByOutcodes(
    outcodes: string[],
    regionLabel?: string,
  ): Promise<AgentDiscoveryResult> {
    // Normalise + dedup the explicit outcode set (a search supplies already-
    // resolved, upper-cased codes, but stay defensive against blanks/dupes).
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const raw of outcodes) {
      const code = raw.trim().toUpperCase();
      if (code.length > 0 && !seen.has(code)) {
        seen.add(code);
        targets.push(code);
      }
    }
    if (targets.length === 0) {
      // No target outcodes — nothing to discover, never an error.
      console.info(
        JSON.stringify({
          type: "info",
          scope: "discovery.outcodes.empty",
        }),
      );
      return { discovered: 0, upserted: 0, skipped: 0, collapsed: 0 };
    }
    // The provider takes `region` for its query CONTEXT — the web-search string.
    // Prefer the search's human place-name label (e.g. "Conwy County"): a search
    // for the raw outcodes ("LL30, LL31, LL32") returns nothing. Fall back to the
    // joined outcodes only when no label is supplied. Either way `outcodes` is
    // what gets stamped onto the discovered agents' coveredOutcodes.
    const region = regionLabel?.trim() || targets.join(", ");
    return this.runDiscovery({ region, outcodes: targets });
  }

  /**
   * The shared discovery pipeline both entry points delegate to: ask the provider
   * for candidates over `outcodes`, then classify → intra-batch-dedup →
   * skip-suppressed → upsert each as an Agent stamped with `outcodes`. The
   * `region` string is the provider's query context + a log label only.
   */
  private async runDiscovery(input: {
    region: string;
    outcodes: string[];
  }): Promise<AgentDiscoveryResult> {
    const { region, outcodes } = input;
    const candidates = await this.provider.discover({ region, outcodes });

    let upserted = 0;
    let skipped = 0;
    let collapsed = 0;
    // `skipped` folds intra-batch duplicates, malformed (unknown) addresses,
    // free-mail (individual) addresses, and already-suppressed contacts.
    // `collapsed` counts extra same-agency mailboxes dropped by per-domain
    // collapse. So discovered === upserted + skipped + collapsed regardless of
    // whether the provider deduped.
    const seen = new Set<string>();
    // Corporate candidates are grouped by agency domain and collapsed to ONE best
    // mailbox each (a 3-inbox agency = one cold contact). Free-mail addresses are
    // NOT persisted at all — they are dropped here (the PECR gate would block
    // every send to them, so a stored record is unsendable dead weight).
    const byDomain = new Map<
      string,
      { email: string; agencyName: string | null; websiteUrl?: string }[]
    >();
    for (const candidate of candidates) {
      const email = candidate.email.trim().toLowerCase();
      if (seen.has(email)) {
        skipped += 1; // intra-batch duplicate
        continue;
      }
      seen.add(email);
      const mailboxType = classifyMailboxType(email);
      if (mailboxType !== "corporate_subscriber") {
        // Malformed (unknown) OR free-mail (individual) → never persisted. PECR:
        // only a corporate subscriber is cold-emailable, so nothing else earns a
        // row in the agent pool.
        skipped += 1;
        continue;
      }
      // Never re-source a suppressed/opted-out contact.
      if (await this.suppressionEntryRepository.isSuppressed(email)) {
        skipped += 1;
        continue;
      }
      // corporate_subscriber — defer to the per-domain collapse below.
      const domain = emailDomain(email)!; // corporate ⇒ a real domain
      const group = byDomain.get(domain) ?? [];
      group.push({
        email,
        agencyName: candidate.agencyName,
        ...(candidate.websiteUrl ? { websiteUrl: candidate.websiteUrl } : {}),
      });
      byDomain.set(domain, group);
    }

    // Collapse each agency domain to its single best mailbox.
    for (const group of byDomain.values()) {
      const bestEmail = pickBestEmail(
        group.map((g) => g.email),
        region,
      );
      const chosen = group.find((g) => g.email === bestEmail) ?? group[0]!;
      await this.agentRepository.upsertByEmail({
        email: chosen.email,
        agencyName: chosen.agencyName,
        website: agentWebsite(chosen.email, chosen.websiteUrl),
        mailboxType: "corporate_subscriber",
        coveredOutcodes: outcodes,
      });
      upserted += 1;
      collapsed += group.length - 1;
    }

    console.info(
      JSON.stringify({
        type: "info",
        scope: "discovery.region.done",
        region,
        discovered: candidates.length,
        upserted,
        skipped,
        collapsed,
      }),
    );
    return { discovered: candidates.length, upserted, skipped, collapsed };
  }
}

let singleton: AgentDiscoveryService | null = null;

export function getAgentDiscoveryService(
  deps?: AgentDiscoveryDependencies,
): AgentDiscoveryService {
  if (deps) {
    singleton = new DefaultAgentDiscoveryService(deps);
    return singleton;
  }
  if (!singleton) {
    throw new Error(
      "AgentDiscoveryService not initialised — call getAgentDiscoveryService(deps) at worker boot",
    );
  }
  return singleton;
}

export function _setAgentDiscoveryServiceForTesting(
  service: AgentDiscoveryService | null,
): void {
  singleton = service;
}
