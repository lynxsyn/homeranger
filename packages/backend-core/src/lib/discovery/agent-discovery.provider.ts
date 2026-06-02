/**
 * AgentDiscoveryProvider — the swappable seam that finds estate agents in a UK
 * region (M7). The real impl (firecrawl-agent-discovery.provider.ts) does web
 * search/extract; this module owns the interface + types + the deterministic,
 * network-free fake the worker uses under DISCOVERY_FAKE=1 (E2E/CI never hit the
 * network or spend). Mirrors the EmailProvider seam from M6.
 *
 * Discovery only SOURCES candidates; the ComplianceGuard still gates every send
 * (corporate-subscriber only), and the AgentDiscoveryService classifies + dedups
 * before any outreach.
 */
export interface DiscoverInput {
  /** Region name (drives the search query + the email context). */
  region: string;
  /** Resolved postcode outcodes for the region (relevance/targeting). */
  outcodes: string[];
}

export interface DiscoveredAgent {
  email: string;
  agencyName: string;
  websiteUrl?: string;
}

export interface AgentDiscoveryProvider {
  discover(input: DiscoverInput): Promise<DiscoveredAgent[]>;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Deterministic, network-free discovery for E2E/CI (DISCOVERY_FAKE=1). Derives a
 * stable set of BUSINESS-domain agents from the region slug so the downstream
 * guard classifies them corporate_subscriber and an allowed send can be proven
 * end-to-end. Zero spend, no scraping.
 */
export class FakeAgentDiscoveryProvider implements AgentDiscoveryProvider {
  async discover(input: DiscoverInput): Promise<DiscoveredAgent[]> {
    const slug = slugify(input.region) || "region";
    return [
      {
        email: `info@${slug}-estates.example`,
        agencyName: `${input.region} Estates`,
        websiteUrl: `https://${slug}-estates.example`,
      },
      {
        email: `sales@${slug}-property.example`,
        agencyName: `${input.region} Property Co`,
        websiteUrl: `https://${slug}-property.example`,
      },
    ];
  }
}
