import { afterEach, describe, expect, it } from "vitest";
import {
  classifyRcptReply,
  FakeEmailVerifier,
  getEmailVerifier,
  mapNeverBounceResult,
  mapZeroBounceResult,
} from "./email-verifier.js";
import { SmtpEmailVerifier } from "./smtp-email-verifier.js";
import { NeverBounceEmailVerifier } from "./neverbounce-email-verifier.js";
import { ZeroBounceEmailVerifier } from "./zerobounce-email-verifier.js";

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

describe("mapNeverBounceResult", () => {
  it("maps valid → deliverable and invalid → undeliverable", () => {
    expect(mapNeverBounceResult("valid")).toBe("deliverable");
    expect(mapNeverBounceResult("invalid")).toBe("undeliverable");
  });

  it("treats catchall / disposable / unknown / unrecognised as unknown (sendable)", () => {
    expect(mapNeverBounceResult("catchall")).toBe("unknown");
    expect(mapNeverBounceResult("disposable")).toBe("unknown");
    expect(mapNeverBounceResult("unknown")).toBe("unknown");
    expect(mapNeverBounceResult("")).toBe("unknown");
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

describe("mapZeroBounceResult", () => {
  it("maps valid → deliverable; invalid + spamtrap → undeliverable", () => {
    expect(mapZeroBounceResult("valid")).toBe("deliverable");
    expect(mapZeroBounceResult("invalid", "mailbox_not_found")).toBe(
      "undeliverable",
    );
    expect(mapZeroBounceResult("spamtrap", "")).toBe("undeliverable");
  });

  it("keeps a ROLE-BASED do_not_mail SENDABLE — it's the agency inbox we target", () => {
    // Load-bearing: ZeroBounce flags info@/sales@ as do_not_mail/role_based, but
    // those are exactly the addresses we want. They MUST NOT be blocked.
    expect(mapZeroBounceResult("do_not_mail", "role_based")).toBe("unknown");
    expect(mapZeroBounceResult("do_not_mail", "role_based_catch_all")).toBe(
      "unknown",
    );
  });

  it("blocks a genuinely toxic do_not_mail (disposable/toxic/suppression/trap)", () => {
    expect(mapZeroBounceResult("do_not_mail", "disposable")).toBe(
      "undeliverable",
    );
    expect(mapZeroBounceResult("do_not_mail", "toxic")).toBe("undeliverable");
    expect(mapZeroBounceResult("do_not_mail", "global_suppression")).toBe(
      "undeliverable",
    );
    expect(mapZeroBounceResult("do_not_mail", "possible_trap")).toBe(
      "undeliverable",
    );
  });

  it("treats catch-all / unknown / abuse / unrecognised as unknown (sendable)", () => {
    expect(mapZeroBounceResult("catch-all", "")).toBe("unknown");
    expect(mapZeroBounceResult("unknown", "")).toBe("unknown");
    expect(mapZeroBounceResult("abuse", "")).toBe("unknown");
    expect(mapZeroBounceResult("error", "")).toBe("unknown");
    // mx_forward = the domain relays mail elsewhere (a routing config), NOT a
    // dead mailbox — must stay sendable, same as role_based.
    expect(mapZeroBounceResult("do_not_mail", "mx_forward")).toBe("unknown");
  });
});

describe("getEmailVerifier", () => {
  const originalFake = process.env.EMAIL_VERIFY_FAKE;
  const originalProvider = process.env.EMAIL_VERIFY_PROVIDER;
  const restore = (name: string, value: string | undefined): void => {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  };
  afterEach(() => {
    restore("EMAIL_VERIFY_FAKE", originalFake);
    restore("EMAIL_VERIFY_PROVIDER", originalProvider);
  });

  it("returns the fake when EMAIL_VERIFY_FAKE=1 (wins over provider)", () => {
    process.env.EMAIL_VERIFY_FAKE = "1";
    process.env.EMAIL_VERIFY_PROVIDER = "neverbounce";
    expect(getEmailVerifier()).toBeInstanceOf(FakeEmailVerifier);
  });

  it("returns the ZeroBounce verifier when EMAIL_VERIFY_PROVIDER=zerobounce", () => {
    delete process.env.EMAIL_VERIFY_FAKE;
    process.env.EMAIL_VERIFY_PROVIDER = "zerobounce";
    expect(getEmailVerifier()).toBeInstanceOf(ZeroBounceEmailVerifier);
  });

  it("returns the NeverBounce verifier when EMAIL_VERIFY_PROVIDER=neverbounce", () => {
    delete process.env.EMAIL_VERIFY_FAKE;
    process.env.EMAIL_VERIFY_PROVIDER = "neverbounce";
    expect(getEmailVerifier()).toBeInstanceOf(NeverBounceEmailVerifier);
  });

  it("falls back to the SMTP verifier when neither flag is set", () => {
    delete process.env.EMAIL_VERIFY_FAKE;
    delete process.env.EMAIL_VERIFY_PROVIDER;
    expect(getEmailVerifier()).toBeInstanceOf(SmtpEmailVerifier);
  });
});
