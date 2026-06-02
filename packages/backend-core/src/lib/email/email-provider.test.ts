import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FakeEmailSendProvider,
  getOutreachEmailConfig,
} from "./email-provider.js";

const baseInput = {
  to: "branch@agency.test",
  from: "Homescout <hi@homescout.test>",
  subject: "Hello",
  bodyText: "body",
  idempotencyKey: "outreach:send:agent-1",
};

describe("FakeEmailSendProvider", () => {
  it("derives a deterministic id from the idempotency key (retry-safe)", async () => {
    const p = new FakeEmailSendProvider();
    const a = await p.send(baseInput);
    const b = await p.send({ ...baseInput, subject: "Different subject" });
    // Same key → same id (a retry returns the original message id, no double send).
    expect(a.providerMessageId).toBe(b.providerMessageId);
    expect(a.providerMessageId).toMatch(/^fake-/);
  });

  it("yields a different id for a different idempotency key", async () => {
    const p = new FakeEmailSendProvider();
    const a = await p.send(baseInput);
    const b = await p.send({ ...baseInput, idempotencyKey: "outreach:send:agent-2" });
    expect(a.providerMessageId).not.toBe(b.providerMessageId);
  });
});

describe("getOutreachEmailConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("throws when RESEND_FROM is unset", () => {
    vi.stubEnv("RESEND_FROM", "");
    expect(() => getOutreachEmailConfig()).toThrow(/RESEND_FROM/);
  });

  it("returns the from address (+ optional reply-to)", () => {
    vi.stubEnv("RESEND_FROM", "Homescout <hi@homescout.test>");
    vi.stubEnv("RESEND_REPLY_TO", "reply@homescout.test");
    expect(getOutreachEmailConfig()).toEqual({
      from: "Homescout <hi@homescout.test>",
      replyTo: "reply@homescout.test",
    });
  });
});
