import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  clampLimit,
  decodeCompositeCursor,
  decodeCursor,
  encodeCompositeCursor,
  encodeCursor,
  paginate,
} from "./cursor.js";

describe("clampLimit", () => {
  it("defaults to 20 when omitted", () => {
    expect(clampLimit()).toBe(DEFAULT_PAGE_LIMIT);
  });

  it("clamps above the max to 100", () => {
    expect(clampLimit(1000)).toBe(MAX_PAGE_LIMIT);
  });

  it("clamps below 1 up to 1 and truncates fractions", () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(3.9)).toBe(3);
  });
});

describe("encodeCursor / decodeCursor", () => {
  it("round-trips an id", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const decoded = decodeCursor(encodeCursor({ id }));
    expect(decoded.id).toBe(id);
  });

  it("throws a BAD_REQUEST TRPCError on garbage", () => {
    expect(() => decodeCursor("not-base64-json")).toThrow(TRPCError);
    try {
      decodeCursor("not-base64-json");
    } catch (err) {
      expect((err as TRPCError).code).toBe("BAD_REQUEST");
      expect((err as TRPCError).message).toBe("Invalid cursor");
    }
  });

  it("throws when the decoded shape is missing fields", () => {
    const bad = Buffer.from(JSON.stringify({ id: 1 })).toString("base64");
    expect(() => decodeCursor(bad)).toThrow(TRPCError);
  });
});

describe("encodeCompositeCursor / decodeCompositeCursor", () => {
  it("round-trips a numeric sortValue + id", () => {
    const payload = { sortValue: 42_500_000, id: "abc" };
    expect(decodeCompositeCursor(encodeCompositeCursor(payload))).toEqual(
      payload,
    );
  });

  it("round-trips a string sortValue (ISO timestamp) + id", () => {
    const payload = { sortValue: "2026-01-01T00:00:00.000Z", id: "def" };
    expect(decodeCompositeCursor(encodeCompositeCursor(payload))).toEqual(
      payload,
    );
  });

  it("throws a BAD_REQUEST TRPCError on garbage", () => {
    expect(() => decodeCompositeCursor("@@not-json@@")).toThrow(TRPCError);
    try {
      decodeCompositeCursor("@@not-json@@");
    } catch (err) {
      expect((err as TRPCError).code).toBe("BAD_REQUEST");
      expect((err as TRPCError).message).toBe("Invalid cursor");
    }
  });

  it("throws when id is missing or non-string", () => {
    const noId = Buffer.from(JSON.stringify({ sortValue: 1 })).toString(
      "base64",
    );
    expect(() => decodeCompositeCursor(noId)).toThrow(TRPCError);
    const badId = Buffer.from(
      JSON.stringify({ sortValue: 1, id: 7 }),
    ).toString("base64");
    expect(() => decodeCompositeCursor(badId)).toThrow(TRPCError);
  });

  it("throws when sortValue is missing or not number/string", () => {
    const noSort = Buffer.from(JSON.stringify({ id: "x" })).toString("base64");
    expect(() => decodeCompositeCursor(noSort)).toThrow(TRPCError);
    const badSort = Buffer.from(
      JSON.stringify({ id: "x", sortValue: { nested: true } }),
    ).toString("base64");
    expect(() => decodeCompositeCursor(badSort)).toThrow(TRPCError);
  });
});

describe("paginate", () => {
  const row = (id: string) => ({ id });

  it("returns nextCursor null when not over-fetched", () => {
    const page = paginate([row("a"), row("b")], 2);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("drops the over-fetched row and encodes the last kept row", () => {
    const page = paginate([row("a"), row("b"), row("c")], 2);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor!).id).toBe("b");
  });
});
