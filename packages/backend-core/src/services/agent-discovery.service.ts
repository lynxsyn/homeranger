/**
 * AgentDiscoveryService (M7) — resolves a UK region to outcodes, asks the
 * AgentDiscoveryProvider for estate agents there, classifies + dedups them, and
 * upserts them as Agents ready for the existing ComplianceGuard-gated outreach.
 *
 * Discovery only SOURCES; it never sends. Classification sets mailboxType so the
 * guard's PECR gate (corporate_subscriber only) decides who is cold-emailable —
 * a discovered personal mailbox is stored (individual) but never sent to.
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

export interface AgentDiscoveryResult {
  /** Candidates returned by the provider. */
  discovered: number;
  /** Candidates upserted as Agents (incl. individuals, which the guard blocks). */
  upserted: number;
  /** Candidates skipped (already suppressed). */
  skipped: number;
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
      return { discovered: 0, upserted: 0, skipped: 0 };
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
      return { discovered: 0, upserted: 0, skipped: 0 };
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
    // `skipped` folds: intra-batch duplicates, malformed (unknown) addresses, and
    // already-suppressed contacts — so `discovered === upserted + skipped` holds
    // regardless of whether the provider deduped.
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const email = candidate.email.trim().toLowerCase();
      if (seen.has(email)) {
        skipped += 1; // intra-batch duplicate
        continue;
      }
      seen.add(email);
      const mailboxType = classifyMailboxType(email);
      if (mailboxType === "unknown") {
        skipped += 1; // malformed address — never persisted as an Agent
        continue;
      }
      // Never re-source a suppressed/opted-out contact.
      if (await this.suppressionEntryRepository.isSuppressed(email)) {
        skipped += 1;
        continue;
      }
      await this.agentRepository.upsertByEmail({
        email,
        agencyName: candidate.agencyName,
        mailboxType,
        coveredOutcodes: outcodes,
      });
      upserted += 1;
    }

    console.info(
      JSON.stringify({
        type: "info",
        scope: "discovery.region.done",
        region,
        discovered: candidates.length,
        upserted,
        skipped,
      }),
    );
    return { discovered: candidates.length, upserted, skipped };
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
