import { describe, expect, it } from "vitest";
import { extractReplyText, firstHttpUrl } from "./reply-text.js";

// The footer our own outreach appends — the exact text that was false-positiving
// the opt-out detector when an agent's reply quoted it.
const OUTREACH_QUOTE_FOOTER =
  "To stop receiving these emails, unsubscribe here: https://homeranger.app/api/outreach/unsubscribe?email=a@b.co&token=xyz";

describe("extractReplyText", () => {
  it("returns the whole text when there is no quoted history", () => {
    expect(extractReplyText("Hi, yes we have a few coming up. Bryan")).toBe(
      "Hi, yes we have a few coming up. Bryan",
    );
  });

  it("returns '' for null/undefined/empty", () => {
    expect(extractReplyText(null)).toBe("");
    expect(extractReplyText(undefined)).toBe("");
    expect(extractReplyText("   ")).toBe("");
  });

  it("strips a Gmail/Proton 'On ... wrote:' attribution + quoted footer", () => {
    const body = [
      "hi nothing now thank you",
      "",
      "On Wed, Jun 4, 2026 at 9:25 AM Bryan <bryan@homeranger.app> wrote:",
      "> Hello, I'm a private buyer searching in your area.",
      `> ${OUTREACH_QUOTE_FOOTER}`,
    ].join("\n");
    expect(extractReplyText(body)).toBe("hi nothing now thank you");
  });

  it("strips an Apple Mail attribution", () => {
    const body = [
      "Sure, see attached.",
      "",
      "On Jun 4, 2026, at 9:25 AM, Bryan <bryan@homeranger.app> wrote:",
      "",
      `${OUTREACH_QUOTE_FOOTER}`,
    ].join("\n");
    expect(extractReplyText(body)).toBe("Sure, see attached.");
  });

  it("strips an Outlook -----Original Message----- block", () => {
    const body = [
      "Thanks for getting in touch.",
      "",
      "-----Original Message-----",
      "From: Bryan <bryan@homeranger.app>",
      OUTREACH_QUOTE_FOOTER,
    ].join("\n");
    expect(extractReplyText(body)).toBe("Thanks for getting in touch.");
  });

  it("strips an Outlook From:/Sent: header block", () => {
    const body = [
      "Nothing right now, thanks.",
      "",
      "From: Bryan <bryan@homeranger.app>",
      "Sent: Wednesday, June 4, 2026 9:25 AM",
      "To: agent@agency.co.uk",
      "Subject: A private buyer looking in your area",
      OUTREACH_QUOTE_FOOTER,
    ].join("\n");
    expect(extractReplyText(body)).toBe("Nothing right now, thanks.");
  });

  it("strips a long underscore divider", () => {
    const body = ["No thanks.", "", "_".repeat(40), OUTREACH_QUOTE_FOOTER].join(
      "\n",
    );
    expect(extractReplyText(body)).toBe("No thanks.");
  });

  it("strips a bare '>' quote block with no attribution line", () => {
    const body = [
      "Yes please keep me posted.",
      "",
      "> Hello, I'm a private buyer.",
      `> ${OUTREACH_QUOTE_FOOTER}`,
    ].join("\n");
    expect(extractReplyText(body)).toBe("Yes please keep me posted.");
  });

  it("cuts at the EARLIEST marker (attribution before the '>' block)", () => {
    const body = [
      "Here is one: 12 Gay Street, Bath BA1 2NT, 3-bed, £625,000.",
      "On Jun 4 Bryan wrote:",
      "> quoted",
    ].join("\n");
    expect(extractReplyText(body)).toBe(
      "Here is one: 12 Gay Street, Bath BA1 2NT, 3-bed, £625,000.",
    );
  });

  it("does not false-cut a reply that merely contains '>' mid-line", () => {
    expect(extractReplyText("budget > 500k, 3 beds, with a garden")).toBe(
      "budget > 500k, 3 beds, with a garden",
    );
  });

  it("preserves a real STOP that the agent actually typed", () => {
    const body = ["STOP", "", "On Jun 4 Bryan wrote:", "> unsubscribe here: ..."].join(
      "\n",
    );
    expect(extractReplyText(body)).toBe("STOP");
  });

  it("returns '' when the whole body is quoted history (no new text)", () => {
    const body = [
      "On Jun 4 Bryan wrote:",
      "> Hello",
      `> ${OUTREACH_QUOTE_FOOTER}`,
    ].join("\n");
    expect(extractReplyText(body)).toBe("");
  });

  it("normalises CRLF line endings before scanning", () => {
    const body = "hi thanks\r\n\r\nOn Jun 4 Bryan wrote:\r\n> unsubscribe here";
    expect(extractReplyText(body)).toBe("hi thanks");
  });
});

describe("firstHttpUrl", () => {
  it("returns the first http(s) URL, trimming trailing punctuation", () => {
    expect(firstHttpUrl("see https://rightmove.co.uk/properties/123 here")).toBe(
      "https://rightmove.co.uk/properties/123",
    );
    expect(firstHttpUrl("Listing: https://zoopla.co.uk/p/9.")).toBe(
      "https://zoopla.co.uk/p/9",
    );
    expect(firstHttpUrl("http://example.com/x?y=1&z=2")).toBe(
      "http://example.com/x?y=1&z=2",
    );
  });

  it("returns the FIRST when several are present", () => {
    expect(firstHttpUrl("a https://one.com b https://two.com")).toBe(
      "https://one.com",
    );
  });

  it("returns null when there is no http(s) URL", () => {
    expect(
      firstHttpUrl("call me on 0123 456 or visit www.agency.com"),
    ).toBeNull();
    expect(firstHttpUrl("mailto:agent@agency.com")).toBeNull();
    expect(firstHttpUrl(null)).toBeNull();
    expect(firstHttpUrl("")).toBeNull();
  });
});
