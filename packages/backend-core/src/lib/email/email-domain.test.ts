import { describe, expect, it } from "vitest";
import { emailDomain, emailLocalPart } from "./email-domain.js";

describe("emailDomain", () => {
  it("returns the lower-cased domain after the last @", () => {
    expect(emailDomain("conwy@fletcherpoole.com")).toBe("fletcherpoole.com");
    expect(emailDomain("Sales@Fletcher-Poole.CO.UK")).toBe("fletcher-poole.co.uk");
  });

  it("uses the LAST @ (defensive against odd local-parts)", () => {
    expect(emailDomain("a@b@agency.co.uk")).toBe("agency.co.uk");
  });

  it("returns null for a malformed address", () => {
    expect(emailDomain("not-an-email")).toBeNull();
    expect(emailDomain("@no-local.com")).toBeNull();
    expect(emailDomain("no-domain@")).toBeNull();
    expect(emailDomain("no-dot@localhost")).toBeNull();
    expect(emailDomain("")).toBeNull();
  });
});

describe("emailLocalPart", () => {
  it("returns the lower-cased local-part before the last @", () => {
    expect(emailLocalPart("Conwy@fletcherpoole.com")).toBe("conwy");
    expect(emailLocalPart("INFO@agency.co.uk")).toBe("info");
  });

  it("returns null for a malformed address", () => {
    expect(emailLocalPart("not-an-email")).toBeNull();
    expect(emailLocalPart("@nolocal.com")).toBeNull();
  });
});
