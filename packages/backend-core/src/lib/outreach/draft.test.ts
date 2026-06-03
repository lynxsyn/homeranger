import { describe, expect, it } from "vitest";
import { draftOutreach } from "./draft.js";

describe("draftOutreach", () => {
  it("greets by agency name and lists covered outcodes", () => {
    const d = draftOutreach({
      agencyName: "Acme Lettings",
      coveredOutcodes: ["SW1A", "W1"],
    });
    expect(d.subject).toContain("Buyer enquiry");
    expect(d.bodyText).toContain("Acme Lettings");
    expect(d.bodyText).toContain("SW1A, W1");
    expect(d.bodyHtml).toContain("<p>");
  });

  it("falls back to a generic greeting + area when fields are absent", () => {
    const d = draftOutreach({});
    expect(d.bodyText).toContain("Hello there,");
    expect(d.bodyText).toContain("your area");
  });

  it("includes the search-profile preferences when provided", () => {
    const d = draftOutreach({ profilePreferences: "3-bed garden flat" });
    expect(d.bodyText).toContain("3-bed garden flat");
  });

  it("appends the one-click unsubscribe link + footer when a URL is given", () => {
    const d = draftOutreach({ unsubscribeUrl: "https://app.test/u?token=abc" });
    expect(d.bodyText).toContain("unsubscribe here: https://app.test/u?token=abc");
    expect(d.bodyHtml).toContain('href="https://app.test/u?token=abc"');
  });

  it("HTML-escapes interpolated agency text", () => {
    const d = draftOutreach({ agencyName: "A & B <Estates>" });
    expect(d.bodyHtml).toContain("A &amp; B &lt;Estates&gt;");
    expect(d.bodyHtml).not.toContain("<Estates>");
  });

  it("uses no em dashes in the subject or body (AI tell)", () => {
    const d = draftOutreach({
      agencyName: "Acme Lettings",
      coveredOutcodes: ["SW1A"],
      profilePreferences: "3-bed garden flat",
      unsubscribeUrl: "https://app.test/u?token=abc",
    });
    expect(d.subject).not.toContain("—");
    expect(d.bodyText).not.toContain("—");
  });
});
