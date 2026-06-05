/**
 * Firecrawl-backed agent discovery (M7) — the REAL impl behind the
 * AgentDiscoveryProvider interface. Searches the web for estate agents in a
 * region and extracts contact emails. DORMANT without FIRECRAWL_API_KEY: the
 * worker only constructs it when DISCOVERY_FAKE !== "1", so E2E/CI use the
 * deterministic fake and incur no spend/network.
 *
 * RECALL MODEL (the M7 recall improvement): the original impl did ONE generic
 * "/v1/search" call (one query: "estate agents in {region}, UK", capped at
 * DISCOVERY_SEARCH_LIMIT) and regex-extracted emails from the returned markdown.
 * That ranked toward big aggregators (missed small independents) and dropped any
 * agency whose email is not plaintext on the fetched page. This impl instead:
 *   1. FANS OUT across several targeted queries (buildDiscoveryQueries) —
 *      estate/letting/independent + per-outcode — each with its OWN per-query
 *      DISCOVERY_SEARCH_LIMIT (still default 20, now PER QUERY), and unions +
 *      URL-dedups the search results.
 *   2. Regex-extracts emails from each result's markdown (extractEmails), AND
 *   3. NEW — for the unique agency contact pages that yielded NO plaintext email,
 *      calls Firecrawl SYNCHRONOUS structured extraction (/v1/scrape with a JSON
 *      schema) on up to DISCOVERY_CONTACT_EXTRACT_MAX pages to recover emails not
 *      present as plaintext in the search snippet. Gated by
 *      DISCOVERY_CONTACT_EXTRACT (default ON).
 *
 * Total spend is bounded: at most DISCOVERY_MAX_QUERIES searches +
 * DISCOVERY_CONTACT_EXTRACT_MAX structured scrapes per discover().
 *
 * The RECALL LOGIC (query fan-out, email extraction, dedup, agency-name
 * derivation) lives in the PURE, UNIT-TESTED discovery-queries.ts. This file is
 * the thin network shell around it — integration-/operator-proven (like
 * RealResendHydrator + the Firecrawl listing-scrape adapter), NOT unit-tested,
 * coverage-excluded as network I/O. The decision to use Firecrawl is recorded in
 * docs/decisions/2026-06-02-agent-discovery-vendor.md.
 *
 * VERIFY THE FIRECRAWL SHAPE LIVE before relying on the contact-extract path.
 * Verified against the current Firecrawl v1 docs (context7, 2026-06-05):
 *   - /v1/search  → POST {query,limit,scrapeOptions:{formats:["markdown"]}}
 *                   → {data: [{url,title,description,markdown,metadata}]}. v1
 *                     search returns ONE synchronous page; it exposes no native
 *                     pagination cursor, so we issue ONE page per query and union
 *                     across the fan-out (that IS the recall lever).
 *   - /v1/scrape  → POST {url,formats:["json"],jsonOptions:{schema,prompt}}
 *                   → {data:{json:{...schema}, markdown?, metadata?}}. Chosen over
 *                     the dedicated /v1/extract endpoint because /v1/extract is
 *                     ASYNC (returns a job id you must poll); /v1/scrape+json is
 *                     SYNCHRONOUS per-URL, simpler to bound, and matches the
 *                     listing-scrape adapter's existing /v1/scrape usage. If the
 *                     live json-key shape differs, only collectFromContactPages
 *                     needs adjusting — the recall fan-out is unaffected.
 */
import type {
  AgentDiscoveryProvider,
  DiscoverInput,
  DiscoveredAgent,
} from "./agent-discovery.provider.js";
import {
  DEFAULT_MAX_QUERIES,
  agencyNameFrom,
  buildDiscoveryQueries,
  dedupeByEmail,
  extractEmails,
  hostnameOf,
} from "./discovery-queries.js";

interface FirecrawlSearchResult {
  url?: string;
  title?: string;
  markdown?: string;
  metadata?: { title?: string };
}

/** The structured-extract result for ONE agency contact page. */
interface ContactExtraction {
  agencyName?: string;
  email?: string;
  emails?: string[];
}

/** Parse a positive-int env var with a default + a >0 clamp. */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class FirecrawlAgentDiscoveryProvider implements AgentDiscoveryProvider {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  /** Per-QUERY search result cap (was the single global cap pre-recall). */
  private readonly limit: number;
  /** Max search queries in the fan-out (bounds search spend). */
  private readonly maxQueries: number;
  /** Whether to recover emails via per-page structured extraction. */
  private readonly contactExtract: boolean;
  /** Max contact pages to structured-extract (bounds scrape spend). */
  private readonly contactExtractMax: number;

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
    this.limit = parsePositiveInt(process.env.DISCOVERY_SEARCH_LIMIT, 20);
    this.maxQueries = parsePositiveInt(
      process.env.DISCOVERY_MAX_QUERIES,
      DEFAULT_MAX_QUERIES,
    );
    // ON unless explicitly disabled with "0".
    this.contactExtract = process.env.DISCOVERY_CONTACT_EXTRACT !== "0";
    this.contactExtractMax = parsePositiveInt(
      process.env.DISCOVERY_CONTACT_EXTRACT_MAX,
      25,
    );
  }

  async discover(input: DiscoverInput): Promise<DiscoveredAgent[]> {
    if (!this.apiKey) {
      // Config gap, not transient — drop the job (don't retry forever).
      throw Object.assign(
        new Error("FIRECRAWL_API_KEY not set — agent discovery is disabled"),
        { retryable: false },
      );
    }

    // 1. FAN OUT: build the bounded, deduped query set and search each (one page
    //    per query — v1 search has no pagination cursor). Union + URL-dedup the
    //    result pages so the per-page extraction below runs once per URL.
    const queries = buildDiscoveryQueries(input.region, input.outcodes, {
      maxQueries: this.maxQueries,
    });
    const byUrl = new Map<string, FirecrawlSearchResult>();
    const noUrl: FirecrawlSearchResult[] = [];
    // Best-effort PER QUERY: the fan-out turned one failure point into N, so a
    // transient error on one query must NOT discard the others (the old single
    // query had nothing to lose; this one does). Track whether ANY query
    // succeeded so a TOTAL outage still surfaces a (retryable) error rather than
    // masquerading as "no agents found".
    let anySearchOk = false;
    let lastSearchError: unknown;
    for (const query of queries) {
      let pageResults: FirecrawlSearchResult[];
      try {
        pageResults = await this.search(query);
      } catch (error) {
        lastSearchError = error;
        console.warn(
          JSON.stringify({
            type: "warn",
            scope: "discovery.search.failed",
            query,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        continue;
      }
      anySearchOk = true;
      for (const result of pageResults) {
        if (result.url) {
          if (!byUrl.has(result.url)) {
            byUrl.set(result.url, result);
          }
        } else {
          noUrl.push(result);
        }
      }
    }
    // EVERY query failed → surface the error (preserving its retryable flag) so
    // the job retries; an empty success would hide a full Firecrawl outage.
    if (!anySearchOk && queries.length > 0) {
      throw (
        lastSearchError ??
        Object.assign(new Error("all discovery searches failed"), {
          retryable: true,
        })
      );
    }
    const results = [...byUrl.values(), ...noUrl];

    // 2. Regex-extract emails from each result's markdown snippet.
    const agents: DiscoveredAgent[] = [];
    // Contact pages that yielded NO plaintext email are candidates for the NEW
    // structured-extract recovery pass (only real URLs; keyed unique by host).
    const extractCandidates = new Map<string, string>(); // host → url
    for (const result of results) {
      const agencyName = agencyNameFrom(result);
      const emails = extractEmails(result.markdown ?? "");
      if (emails.length > 0) {
        for (const email of emails) {
          agents.push({
            email,
            agencyName,
            ...(result.url ? { websiteUrl: result.url } : {}),
          });
        }
      } else if (result.url) {
        const host = hostnameOf(result.url);
        if (host && !extractCandidates.has(host)) {
          extractCandidates.set(host, result.url);
        }
      }
    }

    // 3. NEW: recover emails NOT present as plaintext via Firecrawl structured
    //    extraction on the contact pages (bounded by contactExtractMax). Honour
    //    robots — Firecrawl handles it; we never bypass it here.
    if (this.contactExtract && extractCandidates.size > 0) {
      const urls = [...extractCandidates.values()].slice(0, this.contactExtractMax);
      for (const url of urls) {
        // Best-effort recovery: a blocked/transient contact page must NEVER abort
        // discovery — the search phase already found agents, and contact-extract
        // is pure upside. Swallow per-URL errors (logged) and keep going.
        try {
          agents.push(...(await this.extractContact(url)));
        } catch (error) {
          console.warn(
            JSON.stringify({
              type: "warn",
              scope: "discovery.extract.failed",
              url,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
    }

    // 4. Union + email-dedup (the service still dedups + per-domain collapses,
    //    but returning a clean set keeps the contract tidy).
    return dedupeByEmail(agents);
  }

  /** POST /v1/search for ONE query; map HTTP errors to the retryable flag. */
  private async search(query: string): Promise<FirecrawlSearchResult[]> {
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
      throwOnHttp(response.status, `Firecrawl search failed: ${response.status}`);
    }
    const body = (await response.json()) as { data?: FirecrawlSearchResult[] };
    return body.data ?? [];
  }

  /**
   * Firecrawl SYNCHRONOUS structured extraction of an agency contact page —
   * /v1/scrape with formats:["json"] + a {agencyName,email} schema — to recover
   * an email that was NOT plaintext in the search snippet. Returns 0..n agents
   * for the page. Best-effort: a non-OK or empty/invalid extraction yields [].
   *
   * VERIFY shape live: response is assumed `{data:{json:{agencyName,email,
   * emails?}, metadata?}}`. If the live key path differs, adjust HERE only.
   */
  private async extractContact(url: string): Promise<DiscoveredAgent[]> {
    const response = await fetch(`${this.baseUrl}/v1/scrape`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ["json"],
        jsonOptions: {
          prompt:
            "Extract the estate agency's name and its public business contact email address(es) from this page.",
          schema: {
            type: "object",
            properties: {
              agencyName: { type: "string" },
              email: { type: "string" },
              emails: { type: "array", items: { type: "string" } },
            },
          },
        },
      }),
    });
    if (!response.ok) {
      throwOnHttp(response.status, `Firecrawl extract failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      data?: { json?: ContactExtraction; metadata?: { title?: string } };
    };
    const json = body.data?.json;
    if (!json) {
      return [];
    }
    // The schema offers a single `email` and/or an `emails[]`; take the union and
    // run it through the same bounded/lower-cased extraction guard (the model can
    // return a raw string, not necessarily a clean address).
    const rawEmails = [
      ...(json.email ? [json.email] : []),
      ...(json.emails ?? []),
    ].join(" ");
    const emails = extractEmails(rawEmails);
    if (emails.length === 0) {
      return [];
    }
    const agencyName =
      json.agencyName?.trim() ||
      agencyNameFrom({ url, metadata: body.data?.metadata });
    return emails.map((email) => ({ email, agencyName, websiteUrl: url }));
  }
}

/** Map an HTTP status to a thrown error with the retryable flag set correctly. */
function throwOnHttp(status: number, message: string): never {
  // 429/5xx are transient (retryable); other non-OK (4xx) are not.
  throw Object.assign(new Error(message), {
    retryable: status === 429 || status >= 500,
  });
}
