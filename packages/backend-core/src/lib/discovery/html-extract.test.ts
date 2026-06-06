/**
 * Unit tests for the pure HTML helpers used by the in-process discovery fetcher
 * (the Serper-backed provider's page-fetch step). These carry real extraction
 * logic — Cloudflare email-obfuscation decoding + a lightweight HTML→text strip
 * for the classifier snippet — so they are unit-proven here (the provider that
 * calls them is a coverage-excluded network shell).
 */
import { describe, expect, it } from "vitest";
import { decodeCfEmail, extractCfEmails, htmlToText } from "./html-extract.js";

describe("decodeCfEmail", () => {
  it("decodes a Cloudflare data-cfemail hex blob (XOR with the leading key byte)", () => {
    // "info@aslets.co.uk" XOR-encoded with key 0x7a (computed below).
    const key = 0x7a;
    const plain = "info@aslets.co.uk";
    let hex = key.toString(16).padStart(2, "0");
    for (const ch of plain) {
      hex += (ch.charCodeAt(0) ^ key).toString(16).padStart(2, "0");
    }
    expect(decodeCfEmail(hex)).toBe(plain);
  });

  it("returns null for a malformed / too-short blob", () => {
    expect(decodeCfEmail("")).toBeNull();
    expect(decodeCfEmail("7a")).toBeNull(); // key only, no payload
    expect(decodeCfEmail("zz!!")).toBeNull(); // non-hex
  });
});

describe("extractCfEmails", () => {
  it("finds + decodes both the data-cfemail span and the email-protection href", () => {
    const key = 0x2b;
    const enc = (plain: string): string => {
      let hex = key.toString(16).padStart(2, "0");
      for (const ch of plain) hex += (ch.charCodeAt(0) ^ key).toString(16).padStart(2, "0");
      return hex;
    };
    const html =
      `<a class="__cf_email__" data-cfemail="${enc("sales@example.co.uk")}">[email&#160;protected]</a>` +
      `<a href="/cdn-cgi/l/email-protection#${enc("info@other.com")}">email</a>`;
    expect(extractCfEmails(html).sort()).toEqual([
      "info@other.com",
      "sales@example.co.uk",
    ]);
  });

  it("returns [] when there is no obfuscated email", () => {
    expect(extractCfEmails("<p>no protected emails here</p>")).toEqual([]);
  });
});

describe("htmlToText", () => {
  it("strips script/style/comments and tags, leaving readable text", () => {
    const html =
      "<html><head><style>.a{color:red}</style><script>var x=1;</script></head>" +
      "<body><h1>Acme Estates</h1><p>Sales &amp; lettings in Conwy.</p><!-- hi --></body></html>";
    const text = htmlToText(html);
    expect(text).toContain("Acme Estates");
    expect(text).toContain("Sales & lettings in Conwy.");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("var x");
    expect(text).not.toContain("<");
  });

  it("collapses whitespace and decodes common entities", () => {
    expect(htmlToText("<p>a&nbsp;&amp;&nbsp;b</p>\n\n   <p>c</p>")).toBe("a & b c");
  });

  it("returns '' for empty input", () => {
    expect(htmlToText("")).toBe("");
  });
});
