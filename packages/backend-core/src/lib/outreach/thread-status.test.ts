import { describe, expect, it } from "vitest";
import { advanceThreadStatus } from "./thread-status.js";

describe("advanceThreadStatus", () => {
  it("active → awaiting_reply on first outbound send", () => {
    expect(advanceThreadStatus("active", "outbound_sent")).toBe(
      "awaiting_reply",
    );
  });

  it("awaiting_reply → replied on an inbound reply", () => {
    expect(advanceThreadStatus("awaiting_reply", "inbound_reply")).toBe(
      "replied",
    );
  });

  it("replied → awaiting_reply on a follow-up send", () => {
    expect(advanceThreadStatus("replied", "outbound_sent")).toBe(
      "awaiting_reply",
    );
  });

  it("awaiting_reply → awaiting_reply on a follow-up send (idempotent)", () => {
    expect(advanceThreadStatus("awaiting_reply", "outbound_sent")).toBe(
      "awaiting_reply",
    );
  });

  it("any active state → closed on opt-out/unsubscribe", () => {
    expect(advanceThreadStatus("active", "closed")).toBe("closed");
    expect(advanceThreadStatus("awaiting_reply", "closed")).toBe("closed");
    expect(advanceThreadStatus("replied", "closed")).toBe("closed");
  });

  it("closed is TERMINAL — no event reopens it", () => {
    expect(advanceThreadStatus("closed", "outbound_sent")).toBe("closed");
    expect(advanceThreadStatus("closed", "inbound_reply")).toBe("closed");
    expect(advanceThreadStatus("closed", "closed")).toBe("closed");
  });
});
