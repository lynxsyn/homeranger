import { describe, expect, it } from "vitest";
import { isAuthenticatedSender } from "./email-authentication.js";

/**
 * The Resend inbound webhook is signed by the FORWARDER (Resend), not the
 * original sender, so the `From` header is spoofable. SPF/DKIM verdicts are the
 * only signal that the sending domain is genuine. A spoofer can produce neither
 * a valid DKIM signature for the domain nor an aligned SPF pass, so an
 * affirmative pass is required — "not a hard fail" is NOT enough.
 */
describe("isAuthenticatedSender", () => {
  it("is authenticated when DKIM passes (cryptographic, survives forwarding)", () => {
    expect(isAuthenticatedSender("fail", "pass")).toBe(true);
    expect(isAuthenticatedSender("softfail", "pass")).toBe(true);
    expect(isAuthenticatedSender("none", "pass")).toBe(true);
  });

  it("is authenticated when SPF passes", () => {
    expect(isAuthenticatedSender("pass", "none")).toBe(true);
    expect(isAuthenticatedSender("pass", "fail")).toBe(true);
  });

  it("is NOT authenticated without an affirmative pass (the spoof signature)", () => {
    expect(isAuthenticatedSender("fail", "fail")).toBe(false);
    expect(isAuthenticatedSender("fail", "none")).toBe(false);
    expect(isAuthenticatedSender("softfail", "none")).toBe(false);
    expect(isAuthenticatedSender("none", "none")).toBe(false);
    expect(isAuthenticatedSender("neutral", "neutral")).toBe(false);
    expect(isAuthenticatedSender("unknown", "unknown")).toBe(false);
    expect(isAuthenticatedSender("temperror", "permerror")).toBe(false);
  });
});
