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
import { regionToOutcodes } from "../lib/geo/uk-regions.js";
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
  "sky.com",
  "virginmedia.com",
  "protonmail.com",
  "proton.me",
  "gmx.com",
  "gmx.co.uk",
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
    const outcodes = regionToOutcodes(regionName);
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

    const candidates = await this.provider.discover({
      region: regionName,
      outcodes,
    });

    let upserted = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      const email = candidate.email.trim().toLowerCase();
      // Never re-source a suppressed/opted-out contact.
      if (await this.suppressionEntryRepository.isSuppressed(email)) {
        skipped += 1;
        continue;
      }
      await this.agentRepository.upsertByEmail({
        email,
        agencyName: candidate.agencyName,
        mailboxType: classifyMailboxType(email),
        coveredOutcodes: outcodes,
      });
      upserted += 1;
    }

    console.info(
      JSON.stringify({
        type: "info",
        scope: "discovery.region.done",
        region: regionName,
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
