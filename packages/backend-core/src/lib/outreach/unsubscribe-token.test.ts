import { describe, expect, it } from "vitest";
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "./unsubscribe-token.js";

const SECRET = "test-secret-aaaaaaaaaaaaaaaaaaaa";

describe("unsubscribe-token", () => {
  it("verifies a token it signed", () => {
    const token = signUnsubscribeToken("branch@agency.test", SECRET);
    expect(verifyUnsubscribeToken("branch@agency.test", token, SECRET)).toBe(
      true,
    );
  });

  it("is case-insensitive on the email (normalised both sides)", () => {
    const token = signUnsubscribeToken("Branch@Agency.TEST", SECRET);
    expect(verifyUnsubscribeToken("branch@agency.test", token, SECRET)).toBe(
      true,
    );
  });

  it("rejects a token minted for a DIFFERENT email (no cross-suppression)", () => {
    const token = signUnsubscribeToken("a@agency.test", SECRET);
    expect(verifyUnsubscribeToken("b@agency.test", token, SECRET)).toBe(false);
  });

  it("rejects a tampered / wrong token (constant-time, no length throw)", () => {
    expect(verifyUnsubscribeToken("a@agency.test", "garbage", SECRET)).toBe(
      false,
    );
    expect(verifyUnsubscribeToken("a@agency.test", "", SECRET)).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const token = signUnsubscribeToken("a@agency.test", "other-secret");
    expect(verifyUnsubscribeToken("a@agency.test", token, SECRET)).toBe(false);
  });
});
