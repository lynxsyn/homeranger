/**
 * Shared SSRF-hardened in-process HTTP page fetcher — the FREE replacement for
 * Firecrawl's scrape, used by BOTH the Serper agent-discovery provider (contact
 * pages) and the listing-scrape provider (auction/site index + detail pages).
 *
 * SSRF model: redirects are followed MANUALLY and EVERY hop (the initial URL and
 * each redirect target) must be http(s) AND resolve to a PUBLIC IP before it is
 * fetched (isPrivateIp blocks RFC-1918 / loopback / link-local / IMDS). The body
 * is read with a byte cap (never fully buffered); the whole sequence is bounded
 * by one AbortController. A non-OK status throws with a `retryable` flag.
 *
 * Coverage-excluded (network I/O); the security decision (isPrivateIp) is pure +
 * unit-tested in ssrf-guard.ts.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateIp } from "./ssrf-guard.js";

/** A real desktop UA — some sites 403 a blank/headless UA. */
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** The fetched page: the FINAL URL after redirects + the (capped) body. */
export interface FetchedPage {
  /** The URL actually fetched after following redirects (for canonical ids). */
  finalUrl: string;
  /** The response body, capped at maxBytes. Empty string when skipped. */
  html: string;
}

export interface FetchPageOptions {
  /** Whole-request (all hops) timeout. Default 8000ms. */
  timeoutMs?: number;
  /** Body byte cap. Default 2,000,000. */
  maxBytes?: number;
  /** Max redirect hops to follow. Default 5. */
  maxRedirects?: number;
  /**
   * When false (default) a non-HTML content-type yields an empty body (the
   * discovery contact-page use only wants HTML). Set true to accept any type
   * (e.g. an XML sitemap) up to the byte cap.
   */
  allowNonHtml?: boolean;
}

const DEFAULTS = {
  timeoutMs: 8000,
  maxBytes: 2_000_000,
  maxRedirects: 5,
} as const;

/**
 * GET a URL in-process with the SSRF + cap protections above. Returns
 * `{ finalUrl, html }`; `html` is "" when the target is private/unresolvable,
 * a redirect dead-ends, or the content-type is non-HTML (unless allowNonHtml).
 */
export async function fetchPage(
  url: string,
  options: FetchPageOptions = {},
): Promise<FetchedPage> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        return { finalUrl: current, html: "" };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { finalUrl: current, html: "" };
      }
      if (!(await isPublicHost(parsed.hostname))) {
        return { finalUrl: current, html: "" }; // SSRF: refuse private/unresolvable
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
          return { finalUrl: current, html: "" };
        }
        current = new URL(location, current).toString();
        continue; // re-validate the new hop at the top of the loop
      }
      if (!response.ok) {
        throwOnHttp(response.status, `page fetch failed: ${response.status}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!options.allowNonHtml && contentType && !contentType.includes("html")) {
        await response.body?.cancel();
        return { finalUrl: current, html: "" };
      }
      return { finalUrl: current, html: await readCapped(response, maxBytes) };
    }
    return { finalUrl: current, html: "" }; // too many redirects
  } finally {
    clearTimeout(timer);
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
export function throwOnHttp(status: number, message: string): never {
  throw Object.assign(new Error(message), {
    retryable: status === 429 || status >= 500,
  });
}
