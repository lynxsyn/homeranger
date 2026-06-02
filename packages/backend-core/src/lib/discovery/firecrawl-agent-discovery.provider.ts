/**
 * Firecrawl-backed agent discovery (M7) — the REAL impl behind the
 * AgentDiscoveryProvider interface. Searches the web for estate agents in a
 * region and extracts contact emails from the scraped pages. DORMANT without
 * FIRECRAWL_API_KEY: the worker only constructs it when DISCOVERY_FAKE !== "1",
 * so E2E/CI use the deterministic fake and incur no spend/network.
 *
 * NB: this is integration-/operator-proven (like RealResendHydrator), not
 * unit-tested — coverage-excluded as network I/O. Verify the Firecrawl API shape
 * against the current docs when first enabling. The decision to use Firecrawl is
 * recorded in docs/decisions/2026-06-02-agent-discovery-vendor.md.
 */
import type {
  AgentDiscoveryProvider,
  DiscoverInput,
  DiscoveredAgent,
} from "./agent-discovery.provider.js";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

interface FirecrawlSearchResult {
  url?: string;
  title?: string;
  markdown?: string;
  metadata?: { title?: string };
}

export class FirecrawlAgentDiscoveryProvider implements AgentDiscoveryProvider {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly limit: number;

  // Construction-safe: does NOT throw when FIRECRAWL_API_KEY is unset, so the
  // worker boots regardless (the M6 env-wiring lesson). A discover() with no key
  // fails THAT job (non-retryable drop), never the worker — discovery is dormant
  // until the operator adds the key.
  constructor(
    apiKey: string | undefined = process.env.FIRECRAWL_API_KEY,
    baseUrl: string = process.env.FIRECRAWL_BASE_URL ?? "https://api.firecrawl.dev",
  ) {
    this.apiKey = apiKey?.trim() || undefined;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    const parsedLimit = Number.parseInt(
      process.env.DISCOVERY_SEARCH_LIMIT ?? "20",
      10,
    );
    this.limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20;
  }

  async discover(input: DiscoverInput): Promise<DiscoveredAgent[]> {
    if (!this.apiKey) {
      // Config gap, not transient — drop the job (don't retry forever).
      throw Object.assign(
        new Error("FIRECRAWL_API_KEY not set — agent discovery is disabled"),
        { retryable: false },
      );
    }
    const query = `estate agents in ${input.region}, UK`;
    const response = await fetch(`${this.baseUrl}/v1/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query,
        limit: this.limit,
        scrapeOptions: { formats: ["markdown"] },
      }),
    });
    if (!response.ok) {
      // 429/5xx are transient (retryable); 4xx are not.
      throw Object.assign(
        new Error(`Firecrawl search failed: ${response.status}`),
        { retryable: response.status === 429 || response.status >= 500 },
      );
    }
    const body = (await response.json()) as { data?: FirecrawlSearchResult[] };

    // Dedup discovered emails; derive the agency name from the page title/host.
    const byEmail = new Map<string, DiscoveredAgent>();
    for (const result of body.data ?? []) {
      const text = result.markdown ?? "";
      const agencyName =
        result.metadata?.title?.trim() ||
        result.title?.trim() ||
        hostnameOf(result.url) ||
        "Unknown agency";
      for (const match of text.matchAll(EMAIL_RE)) {
        const email = match[0].toLowerCase();
        if (!byEmail.has(email)) {
          byEmail.set(email, {
            email,
            agencyName,
            ...(result.url ? { websiteUrl: result.url } : {}),
          });
        }
      }
    }
    return [...byEmail.values()];
  }
}

function hostnameOf(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
