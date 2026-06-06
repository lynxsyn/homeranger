/**
 * Serper-backed agent discovery — the self-hosted-friendly REPLACEMENT for the
 * Firecrawl provider (chosen by the 2026-06-06 architecture review; supersedes
 * docs/decisions/2026-06-02-agent-discovery-vendor.md). Splits the two jobs
 * Firecrawl bundled and solves each with the right tool:
 *   1. SEARCH  → Serper.dev (a metered Google SERP API with a REAL error
 *      contract: 4xx/5xx/429 map onto throwOnHttp → BullMQ retry. Unlike a
 *      self-hosted SearXNG, a blocked engine does NOT masquerade as an empty
 *      success and silently zero-out a region).
 *   2. FETCH   → an in-process HTTP GET (global fetch / undici) + the PURE
 *      html-extract helpers (htmlToText + Cloudflare data-cfemail decode). NO
 *      headless browser: we only need text for the regex (extractEmails) + a
 *      short snippet for the Haiku quality-classifier. A browser buys only
 *      post-JS DOM at ~300-400MB; not worth it on the alpine/read-only/1Gi
 *      worker for the JS-rendered residual (measure before adding a fallback).
 *
 * Cost: Serper is 1 credit/search (free <=2,500/mo, then $1/1k, no minimum) and
 * the page fetch is FREE (no per-call credits) — the opposite of the Firecrawl
 * scrape+LLM-extract bill this replaces. The expensive contact-extract LLM pass
 * is GONE: our regex already harvests the emails.
 *
 * DORMANT without SERPER_API_KEY (construction-safe, like the Firecrawl provider:
 * the worker boots; discover() throws retryable:false → the job drops — never the
 * worker). The RECALL logic (query fan-out, email extraction, agency-name
 * derivation, dedup) lives in the PURE, unit-tested discovery-queries.ts +
 * html-extract.ts; this file is the thin, operator-proven network shell over them
 * (coverage-excluded I/O, mirroring firecrawl-agent-discovery.provider.ts).
 *
 * VERIFY THE SERPER SHAPE LIVE — verified 2026-06-06: POST /search {q,gl,num} with
 * header X-API-KEY → {organic:[{title,link,snippet}], credits}. If the live shape
 * drifts, only search() needs adjusting; the recall fan-out is unaffected.
 */
import type {
  AgentDiscoveryProvider,
  DiscoverInput,
  DiscoveredAgent,
} from "./agent-discovery.provider.js";
import {
  DEFAULT_MAX_QUERIES,
  agencyNameForEmail,
  boundedPageText,
  buildDiscoveryQueries,
  dedupeByEmail,
  extractEmails,
  hostnameOf,
  isLikelyAgencyEmail,
  isNonAgencyResult,
} from "./discovery-queries.js";
import { extractCfEmails, htmlToText } from "./html-extract.js";
import { isPrivateIp } from "./ssrf-guard.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** One Serper organic result (the subset we use). */
interface SerperOrganic {
  title?: string;
  link?: string;
  snippet?: string;
}

/** A real desktop UA — some agency sites 403 a blank/headless UA. */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
/** Cap a fetched page so a pathological response can't blow memory (bytes). */
const MAX_HTML_CHARS = 2_000_000;
/** Max redirect hops to follow manually (each hop is SSRF-revalidated). */
const MAX_REDIRECTS = 5;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class SerperAgentDiscoveryProvider implements AgentDiscoveryProvider {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  /** Results per Serper query (Serper default 10). */
  private readonly limit: number;
  /** Max search queries in the fan-out (bounds Serper credits). */
  private readonly maxQueries: number;
  /** Whether to fetch contact pages for emails not in the snippet (FREE). */
  private readonly fetchPages: boolean;
  /** Max contact pages to fetch (bounds wall-clock, not cost). */
  private readonly fetchMax: number;
  /** Per-page fetch timeout. */
  private readonly fetchTimeoutMs: number;

  constructor(
    apiKey: string | undefined = process.env.SERPER_API_KEY,
    baseUrl: string = process.env.SERPER_BASE_URL ?? "https://google.serper.dev",
  ) {
    this.apiKey = apiKey?.trim() || undefined;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.limit = parsePositiveInt(process.env.DISCOVERY_SEARCH_LIMIT, 10);
    this.maxQueries = parsePositiveInt(
      process.env.DISCOVERY_MAX_QUERIES,
      DEFAULT_MAX_QUERIES,
    );
    // ON unless explicitly disabled. NB: a DIFFERENT knob to Firecrawl's
    // DISCOVERY_CONTACT_EXTRACT — the Serper page fetch is FREE, so the
    // Firecrawl cost-cap must not also disable it.
    this.fetchPages = process.env.DISCOVERY_FETCH !== "0";
    this.fetchMax = parsePositiveInt(process.env.DISCOVERY_FETCH_MAX, 25);
    this.fetchTimeoutMs = parsePositiveInt(
      process.env.DISCOVERY_FETCH_TIMEOUT_MS,
      8000,
    );
  }

  async discover(input: DiscoverInput): Promise<DiscoveredAgent[]> {
    if (!this.apiKey) {
      throw Object.assign(
        new Error("SERPER_API_KEY not set — agent discovery is disabled"),
        { retryable: false },
      );
    }

    // 1. FAN OUT: one Serper search per query; union + URL-dedup the organic
    //    results. Best-effort PER query (a transient failure on one query must
    //    not discard the others), but if EVERY query fails, surface the error so
    //    the job retries rather than masquerading as "no agents found".
    const queries = buildDiscoveryQueries(input.region, input.outcodes, {
      maxQueries: this.maxQueries,
    });
    const byUrl = new Map<string, SerperOrganic>();
    let anySearchOk = false;
    let lastSearchError: unknown;
    for (const query of queries) {
      let organic: SerperOrganic[];
      try {
        organic = await this.search(query);
      } catch (error) {
        lastSearchError = error;
        console.warn(
          JSON.stringify({
            type: "warn",
            scope: "discovery.serper.search.failed",
            query,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        continue;
      }
      anySearchOk = true;
      for (const result of organic) {
        if (result.link && !byUrl.has(result.link)) {
          byUrl.set(result.link, result);
        }
      }
    }
    if (!anySearchOk && queries.length > 0) {
      throw (
        lastSearchError ??
        Object.assign(new Error("all Serper searches failed"), {
          retryable: true,
        })
      );
    }

    // 2. Harvest emails present in the search SNIPPET; queue the rest for a page
    //    fetch. Skip council/social-housing/directory result pages outright.
    const agents: DiscoveredAgent[] = [];
    const fetchCandidates = new Map<string, { url: string; title?: string }>();
    for (const result of byUrl.values()) {
      if (isNonAgencyResult({ title: result.title, url: result.link })) {
        continue;
      }
      const snippet = result.snippet ?? "";
      const emails = extractEmails(snippet).filter(isLikelyAgencyEmail);
      if (emails.length > 0) {
        const pageText = boundedPageText(snippet);
        for (const email of emails) {
          agents.push({
            email,
            agencyName: agencyNameForEmail(email, {
              title: result.title,
              url: result.link,
            }),
            ...(result.link ? { websiteUrl: result.link } : {}),
            ...(pageText ? { pageText } : {}),
          });
        }
      } else if (result.link) {
        const host = hostnameOf(result.link);
        if (host && !fetchCandidates.has(host)) {
          fetchCandidates.set(host, { url: result.link, title: result.title });
        }
      }
    }

    // 3. FETCH the contact pages that had no snippet email (the load-bearing
    //    recall path now that we don't get full-page markdown from search).
    //    In-process HTTP GET → regex + Cloudflare-decode. Best-effort per URL.
    if (this.fetchPages && fetchCandidates.size > 0) {
      const targets = [...fetchCandidates.values()].slice(0, this.fetchMax);
      for (const { url, title } of targets) {
        try {
          const html = await this.fetchPage(url);
          if (!html) {
            continue;
          }
          const emails = extractEmails(
            [html, ...extractCfEmails(html)].join(" "),
          ).filter(isLikelyAgencyEmail);
          if (emails.length === 0) {
            continue;
          }
          const pageText = boundedPageText(htmlToText(html));
          for (const email of emails) {
            agents.push({
              email,
              agencyName: agencyNameForEmail(email, { title, url }),
              websiteUrl: url,
              ...(pageText ? { pageText } : {}),
            });
          }
        } catch (error) {
          console.warn(
            JSON.stringify({
              type: "warn",
              scope: "discovery.fetch.failed",
              url,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
    }

    return dedupeByEmail(agents);
  }

  /** POST /search for ONE query; map HTTP errors to the retryable flag. */
  private async search(query: string): Promise<SerperOrganic[]> {
    const response = await fetch(`${this.baseUrl}/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-API-KEY": this.apiKey!,
      },
      body: JSON.stringify({ q: query, gl: "gb", num: this.limit }),
    });
    if (!response.ok) {
      throwOnHttp(response.status, `Serper search failed: ${response.status}`);
    }
    const body = (await response.json()) as { organic?: SerperOrganic[] };
    return body.organic ?? [];
  }

  /**
   * In-process HTTP GET of a contact page → raw HTML (capped). SSRF-hardened:
   * redirects are followed MANUALLY (redirect:"manual") and EVERY hop — the
   * initial URL and each redirect target — is http(s) and resolved to a PUBLIC
   * IP before it is fetched (isPrivateIp blocks RFC-1918 / loopback / link-local
   * / IMDS, defending the new port-80 egress). The body is read with a byte cap
   * (never fully buffered), a non-HTML content-type is skipped, and the whole
   * thing is bounded by one AbortController across all hops.
   */
  private async fetchPage(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      let current = url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        let parsed: URL;
        try {
          parsed = new URL(current);
        } catch {
          return "";
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return "";
        }
        if (!(await isPublicHost(parsed.hostname))) {
          return ""; // SSRF: refuses private/link-local/unresolvable targets
        }
        const response = await fetch(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "user-agent": BROWSER_UA,
            accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) {
            return "";
          }
          current = new URL(location, current).toString(); // resolve relative
          continue; // re-validate the new hop at the top of the loop
        }
        if (!response.ok) {
          throwOnHttp(response.status, `page fetch failed: ${response.status}`);
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType && !contentType.includes("html")) {
          await response.body?.cancel(); // release the connection, don't buffer
          return "";
        }
        return await readCapped(response, MAX_HTML_CHARS);
      }
      return ""; // too many redirects
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Resolve `hostname` and return true only if EVERY A/AAAA record is a public IP.
 * An IP literal is checked directly; an unresolvable host (or any private record,
 * defending against split/rebinding DNS) returns false → the caller won't fetch.
 */
async function isPublicHost(hostname: string): Promise<boolean> {
  if (isIP(hostname)) {
    return !isPrivateIp(hostname);
  }
  try {
    const records = await lookup(hostname, { all: true });
    return records.length > 0 && records.every((r) => !isPrivateIp(r.address));
  } catch {
    return false;
  }
}

/**
 * Read a Response body up to `maxBytes`, then cancel the stream (closing the
 * connection) — so a giant / slow-drip response can never buffer beyond the cap.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) {
    return "";
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }
      const remaining = maxBytes - total;
      if (value.length <= remaining) {
        chunks.push(value);
        total += value.length;
      } else {
        chunks.push(value.subarray(0, remaining));
        total = maxBytes;
      }
      if (total >= maxBytes) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Map an HTTP status to a thrown error with the retryable flag set correctly. */
function throwOnHttp(status: number, message: string): never {
  throw Object.assign(new Error(message), {
    retryable: status === 429 || status >= 500,
  });
}
