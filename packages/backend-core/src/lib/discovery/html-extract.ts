/**
 * Pure HTML helpers for the in-process discovery fetcher (the Serper-backed
 * provider's page-fetch step). NO network, NO deps — deterministic + unit-tested,
 * so the provider that uses them stays a thin coverage-excluded network shell.
 *
 * Two jobs:
 *   1. Cloudflare email-obfuscation decode — many UK agency sites wrap their
 *      contact address in `<span data-cfemail="HEX">` / a `/cdn-cgi/l/email-
 *      protection#HEX` href. The plaintext never appears in the HTML, so our
 *      regex (extractEmails) misses it. The scheme is a fixed XOR with the
 *      leading byte as the key — reversible here without a browser.
 *   2. htmlToText — a lightweight strip (script/style/comments/tags + a few
 *      entities) to produce a readable snippet for the quality classifier. NOT a
 *      readability extractor (those drop the footer/nav where contact emails
 *      live); a raw text dump is exactly what we want.
 */

/**
 * Decode one Cloudflare email-protection hex blob. The first byte is the XOR
 * key; each subsequent byte XOR the key is an ASCII char. Returns null for a
 * malformed blob (odd length, < 2 bytes, or non-hex).
 */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 4 || hex.length % 2 !== 0) {
    return null;
  }
  const key = Number.parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return out;
}

const CF_EMAIL_RE = /(?:data-cfemail="|email-protection#)([0-9a-fA-F]{4,})/g;

/** Find + decode every Cloudflare-obfuscated email in an HTML string (deduped). */
export function extractCfEmails(html: string): string[] {
  const out = new Set<string>();
  for (const match of html.matchAll(CF_EMAIL_RE)) {
    const decoded = decodeCfEmail(match[1]!);
    if (decoded && decoded.includes("@")) {
      out.add(decoded);
    }
  }
  return [...out];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_m, d: string) =>
      String.fromCodePoint(Number.parseInt(d, 10)),
    )
    .replace(/&([a-z]+);/gi, (m, name: string) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name.toLowerCase())
        ? NAMED_ENTITIES[name.toLowerCase()]!
        : m,
    );
}

/**
 * Strip an HTML document to readable text: remove script/style/comments, drop
 * tags, decode common entities, collapse whitespace. Good enough for a classifier
 * snippet (NOT a perfect renderer). Email extraction runs on the raw HTML, not
 * this output, so imperfect stripping never costs email recall.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}
