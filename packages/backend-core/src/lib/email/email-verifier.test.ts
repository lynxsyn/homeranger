import { afterEach, describe, expect, it } from "vitest";
import {
  classifyRcptCode,
  FakeEmailVerifier,
  getEmailVerifier,
} from "./email-verifier.js";
import { SmtpEmailVerifier } from "./smtp-email-verifier.js";

describe("classifyRcptCode", () => {
  it("maps 2xx to deliverable", () => {
    expect(classifyRcptCode(250)).toBe("deliverable");
    expect(classifyRcptCode(200)).toBe("deliverable");
    expect(classifyRcptCode(251)).toBe("deliverable");
  });

  it("maps permanent mailbox rejects to undeliverable", () => {
    for (const code of [550, 551, 553, 554]) {
      expect(classifyRcptCode(code)).toBe("undeliverable");
    }
  });

  it("treats 552 (mailbox full) and 4xx temp failures as unknown", () => {
    expect(classifyRcptCode(552)).toBe("unknown");
    expect(classifyRcptCode(450)).toBe("unknown");
    expect(classifyRcptCode(421)).toBe("unknown");
  });

  it("treats a missing or non-finite code as unknown", () => {
    expect(classifyRcptCode(null)).toBe("unknown");
    expect(classifyRcptCode(Number.NaN)).toBe("unknown");
  });
});

describe("FakeEmailVerifier", () => {
  const verifier = new FakeEmailVerifier();

  it("flags dead-mailbox local-parts undeliverable", async () => {
    expect(await verifier.verify("bounce@agency.co.uk")).toBe("undeliverable");
    expect(await verifier.verify("deadbox@agency.co.uk")).toBe("undeliverable");
    expect(await verifier.verify("nouser@agency.co.uk")).toBe("undeliverable");
  });

  it("flags catch-all/greylist local-parts unknown", async () => {
    expect(await verifier.verify("catchall@agency.co.uk")).toBe("unknown");
    expect(await verifier.verify("greylist@agency.co.uk")).toBe("unknown");
  });

  it("treats ordinary addresses as deliverable", async () => {
    expect(await verifier.verify("info@agency.co.uk")).toBe("deliverable");
    expect(await verifier.verify("hello@agency.co.uk")).toBe("deliverable");
  });
});

describe("getEmailVerifier", () => {
  const original = process.env.EMAIL_VERIFY_FAKE;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.EMAIL_VERIFY_FAKE;
    } else {
      process.env.EMAIL_VERIFY_FAKE = original;
    }
  });

  it("returns the fake when EMAIL_VERIFY_FAKE=1", () => {
    process.env.EMAIL_VERIFY_FAKE = "1";
    expect(getEmailVerifier()).toBeInstanceOf(FakeEmailVerifier);
  });

  it("returns the real SMTP verifier otherwise", () => {
    delete process.env.EMAIL_VERIFY_FAKE;
    expect(getEmailVerifier()).toBeInstanceOf(SmtpEmailVerifier);
  });
});
