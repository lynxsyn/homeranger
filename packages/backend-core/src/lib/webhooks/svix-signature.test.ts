/**
 * Unit tests for the hand-rolled Svix signature verifier (M4 test plan, Unit:
 * signature prehandler). Generates a valid signature in-test with the same
 * algorithm, then asserts: valid → ok; tampered body/sig → signature_mismatch;
 * expired ts → stale_timestamp; missing headers → missing_headers; non-numeric
 * ts → invalid_timestamp. Also asserts BOTH header namings (svix-* and the
 * webhook-* aliases) extract correctly.
 */
import { describe, expect, it } from "vitest";
import {
  decodeSvixSecret,
  extractSvixHeaders,
  signSvixPayload,
  verifySvixSignature,
} from "./svix-signature.js";

// A deterministic `whsec_` secret (base64 of 24 bytes). Arbitrary test value.
const SECRET = `whsec_${Buffer.from("homescout-test-svix-key!!").toString("base64")}`;
const ID = "msg_2abc";
const NOW_MS = 1_900_000_000_000; // fixed clock
const TS = String(Math.floor(NOW_MS / 1000));
const BODY = Buffer.from(JSON.stringify({ type: "email.received", data: { x: 1 } }));

function sign(body: Buffer, id = ID, ts = TS): string {
  return signSvixPayload(body.toString("utf8"), id, ts, SECRET);
}

describe("verifySvixSignature", () => {
  it("accepts a correctly signed payload", () => {
    const sig = sign(BODY);
    const result = verifySvixSignature(
      BODY,
      { id: ID, timestamp: TS, signature: sig },
      SECRET,
      NOW_MS,
    );
    expect(result).toEqual({ ok: true });
  });

  it("accepts when the header carries multiple space-separated signatures", () => {
    const sig = sign(BODY);
    const result = verifySvixSignature(
      BODY,
      { id: ID, timestamp: TS, signature: `v1,deadbeef ${sig}` },
      SECRET,
      NOW_MS,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered body (signature_mismatch)", () => {
    const sig = sign(BODY);
    const tampered = Buffer.from(BODY.toString("utf8") + " ");
    const result = verifySvixSignature(
      tampered,
      { id: ID, timestamp: TS, signature: sig },
      SECRET,
      NOW_MS,
    );
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a wrong-secret signature (signature_mismatch)", () => {
    const otherSecret = `whsec_${Buffer.from("a-different-secret-value!!").toString("base64")}`;
    const sig = signSvixPayload(BODY.toString("utf8"), ID, TS, otherSecret);
    const result = verifySvixSignature(
      BODY,
      { id: ID, timestamp: TS, signature: sig },
      SECRET,
      NOW_MS,
    );
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a stale timestamp (> 300s skew)", () => {
    const sig = sign(BODY);
    const result = verifySvixSignature(
      BODY,
      { id: ID, timestamp: TS, signature: sig },
      SECRET,
      NOW_MS + 301_000,
    );
    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects missing headers", () => {
    const result = verifySvixSignature(
      BODY,
      { id: undefined, timestamp: TS, signature: "v1,x" },
      SECRET,
      NOW_MS,
    );
    expect(result).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("rejects a non-numeric timestamp", () => {
    const sig = sign(BODY);
    const result = verifySvixSignature(
      BODY,
      { id: ID, timestamp: "not-a-number", signature: sig },
      SECRET,
      NOW_MS,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_timestamp" });
  });
});

describe("extractSvixHeaders", () => {
  it("reads the svix-* header naming", () => {
    expect(
      extractSvixHeaders({
        "svix-id": ID,
        "svix-timestamp": TS,
        "svix-signature": "v1,sig",
      }),
    ).toEqual({ id: ID, timestamp: TS, signature: "v1,sig" });
  });

  it("reads the webhook-* alias naming", () => {
    expect(
      extractSvixHeaders({
        "webhook-id": ID,
        "webhook-timestamp": TS,
        "webhook-signature": "v1,sig",
      }),
    ).toEqual({ id: ID, timestamp: TS, signature: "v1,sig" });
  });

  it("returns undefined for absent headers", () => {
    expect(extractSvixHeaders({})).toEqual({
      id: undefined,
      timestamp: undefined,
      signature: undefined,
    });
  });
});

describe("decodeSvixSecret", () => {
  it("strips the whsec_ prefix and base64-decodes", () => {
    const decoded = decodeSvixSecret(SECRET);
    expect(decoded.toString()).toBe("homescout-test-svix-key!!");
  });
});
