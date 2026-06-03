import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FakeEmailSendProvider,
  getOutreachEmailConfig,
  senderDisplayName,
  currentSenderName,
} from "./email-provider.js";

const baseInput = {
  to: "branch@agency.test",
  from: "HomeRanger <hi@homeranger.test>",
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
    vi.stubEnv("RESEND_FROM", "HomeRanger <hi@homeranger.test>");
    vi.stubEnv("RESEND_REPLY_TO", "reply@homeranger.test");
    expect(getOutreachEmailConfig()).toEqual({
      from: "HomeRanger <hi@homeranger.test>",
      replyTo: "reply@homeranger.test",
    });
  });
});

describe("senderDisplayName / currentSenderName", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("extracts the display name from a 'Name <addr>' value", () => {
    expect(senderDisplayName("Bryan <bryan@homeranger.app>")).toBe("Bryan");
    expect(senderDisplayName('"Bryan Smith" <b@x.app>')).toBe("Bryan Smith");
  });

  it("returns null for a bare address or empty/missing value", () => {
    expect(senderDisplayName("bryan@homeranger.app")).toBeNull();
    expect(senderDisplayName("")).toBeNull();
    expect(senderDisplayName(undefined)).toBeNull();
    expect(senderDisplayName("<only@addr.app>")).toBeNull();
  });

  it("currentSenderName reads RESEND_FROM", () => {
    vi.stubEnv("RESEND_FROM", "Bryan <bryan@homeranger.app>");
    expect(currentSenderName()).toBe("Bryan");
    vi.stubEnv("RESEND_FROM", "");
    expect(currentSenderName()).toBeNull();
  });
});
