import { afterEach, describe, expect, it } from "vitest";
import {
  classifyRcptReply,
  FakeEmailVerifier,
  getEmailVerifier,
} from "./email-verifier.js";
import { SmtpEmailVerifier } from "./smtp-email-verifier.js";

describe("classifyRcptReply", () => {
  it("maps 2xx to deliverable", () => {
    expect(classifyRcptReply(250, "2.1.5 Recipient OK")).toBe("deliverable");
    expect(classifyRcptReply(200, "")).toBe("deliverable");
    expect(classifyRcptReply(251, "User not local; will forward")).toBe(
      "deliverable",
    );
  });

  it("flags a genuine non-existent mailbox as undeliverable", () => {
    expect(classifyRcptReply(550, "5.1.1 <a@x>: user unknown")).toBe(
      "undeliverable",
    );
    expect(classifyRcptReply(550, "No such user here")).toBe("undeliverable");
    expect(
      classifyRcptReply(550, "5.1.1 Recipient address rejected: User unknown"),
    ).toBe("undeliverable");
    expect(classifyRcptReply(550, "mailbox unavailable")).toBe("undeliverable");
    expect(classifyRcptReply(550, "Invalid recipient")).toBe("undeliverable");
  });

  it("treats a policy / IP / reputation block as unknown, NOT undeliverable", () => {
    // The real Spamhaus-PBL rejection our cluster IP gets from Outlook/Mimecast.
    expect(
      classifyRcptReply(
        550,
        "5.7.1 Service unavailable, Client host [95.148.83.103] blocked using Spamhaus",
      ),
    ).toBe("unknown");
    expect(
      classifyRcptReply(550, "zen.mimecast.org Listed by PBL, see ..."),
    ).toBe("unknown");
    expect(classifyRcptReply(554, "5.7.1 Access denied")).toBe("unknown");
    expect(classifyRcptReply(550, "5.7.606 Banned sending IP")).toBe("unknown");
    // Ordering invariant: a 5.7.x policy code whose text ALSO looks like a
    // mailbox reject ("recipient address rejected") MUST resolve via the policy
    // branch (which runs first) → unknown, never undeliverable. This is the
    // exact false-positive shape the whole fix exists to prevent.
    expect(classifyRcptReply(550, "5.7.1 Recipient address rejected")).toBe(
      "unknown",
    );
  });

  it("treats temp/greylist (4xx), 552 mailbox-full, and ambiguous 5xx as unknown", () => {
    expect(classifyRcptReply(450, "4.2.0 Greylisted, try again later")).toBe(
      "unknown",
    );
    expect(classifyRcptReply(421, "Service not available")).toBe("unknown");
    expect(classifyRcptReply(552, "5.2.2 Mailbox full")).toBe("unknown");
    expect(classifyRcptReply(550, "Service temporarily unavailable")).toBe(
      "unknown",
    );
  });

  it("treats a missing or non-finite code as unknown", () => {
    expect(classifyRcptReply(null, "")).toBe("unknown");
    expect(classifyRcptReply(Number.NaN, "")).toBe("unknown");
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
