/**
 * Unit tests for the inbound recipient gate. Inbound mail addressed ONLY to an
 * infra/role local-part (DMARC RUA reports to dmarc@, bounce notifications to
 * postmaster@/mailer-daemon@, etc.) must be dropped BEFORE the paid hydrate +
 * Claude extraction — it is never a real agent reply or a listing-bearing email.
 *
 * This is a RECIPIENT-based gate, NOT a sender check: the product deliberately
 * ingests listings from generic, non-agent senders, so we gate on WHO IT'S TO,
 * never on who it's from. Parse misses fail OPEN (treated as deliverable) so a
 * real reply is never silently dropped.
 */
import { describe, expect, it } from "vitest";
import {
  INFRA_RECIPIENT_LOCAL_PARTS,
  hasDeliverableRecipient,
  recipientLocalPart,
} from "./inbound-recipient.js";

describe("recipientLocalPart", () => {
  it("extracts the lower-cased local-part from a bare address", () => {
    expect(recipientLocalPart("dmarc@homeranger.app")).toBe("dmarc");
  });

  it("extracts from a display-name address (Name <a@b>)", () => {
    expect(recipientLocalPart("Bryan <bryan@homeranger.app>")).toBe("bryan");
  });

  it("is case-insensitive and trims surrounding whitespace", () => {
    expect(recipientLocalPart("  POSTMASTER@HOMERANGER.APP ")).toBe(
      "postmaster",
    );
  });

  it("returns null for an unparseable recipient", () => {
    expect(recipientLocalPart("not-an-email")).toBeNull();
    expect(recipientLocalPart("")).toBeNull();
    expect(recipientLocalPart("@homeranger.app")).toBeNull();
  });
});

describe("hasDeliverableRecipient", () => {
  it("is FALSE when the only recipient is an infra local-part (dmarc@)", () => {
    expect(hasDeliverableRecipient(["dmarc@homeranger.app"])).toBe(false);
  });

  it.each([
    "postmaster@homeranger.app",
    "abuse@homeranger.app",
    "mailer-daemon@homeranger.app",
    "bounces@homeranger.app",
    "noreply@homeranger.app",
    "no-reply@homeranger.app",
  ])("is FALSE for the infra recipient %s", (addr) => {
    expect(hasDeliverableRecipient([addr])).toBe(false);
  });

  it("is TRUE for a real outreach inbox (bryan@)", () => {
    expect(hasDeliverableRecipient(["bryan@homeranger.app"])).toBe(true);
  });

  it("is TRUE for the generic listing inbox (inbox@ — the e2e recipient)", () => {
    expect(hasDeliverableRecipient(["inbox@homeranger.app"])).toBe(true);
  });

  it("is TRUE when ANY recipient is a real inbox (mixed dmarc@ + bryan@)", () => {
    expect(
      hasDeliverableRecipient([
        "dmarc@homeranger.app",
        "bryan@homeranger.app",
      ]),
    ).toBe(true);
  });

  it("matches the infra local-part inside a display-name address", () => {
    expect(
      hasDeliverableRecipient(["Postmaster <postmaster@homeranger.app>"]),
    ).toBe(false);
  });

  it("is FALSE for an empty recipient list (anomalous, never a real reply)", () => {
    expect(hasDeliverableRecipient([])).toBe(false);
  });

  it("FAILS OPEN — an unparseable recipient is treated as deliverable", () => {
    // Never silently drop a real reply on a parse miss; only a POSITIVELY
    // infra-only recipient set is dropped.
    expect(hasDeliverableRecipient(["garbled-no-at-sign"])).toBe(true);
  });

  it("exposes dmarc among the infra local-parts (documents the set)", () => {
    expect(INFRA_RECIPIENT_LOCAL_PARTS.has("dmarc")).toBe(true);
  });
});
