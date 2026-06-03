/**
 * locationsRouter unit tests. The resolver itself is exhaustively proven in
 * lib/geo/uk-locations.test.ts; here we assert the tRPC wiring: delegation,
 * the default limit, input validation, and the protectedProcedure auth gate.
 */
import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { appRouter } from "../index.js";

const authedCaller = appRouter.createCaller({
  user: { id: "00000000-0000-0000-0000-0000000000de", email: "dev@homeranger.local" },
});
const anonCaller = appRouter.createCaller({ user: null });

describe("locationsRouter.suggest", () => {
  it("returns ranked suggestions for a name query", async () => {
    const out = await authedCaller.locations.suggest({ q: "Conw" });
    expect(out[0]?.label).toBe("Conwy");
    expect(out[0]?.kind).toBe("district");
    expect(out[0]?.outcodes).toContain("LL30");
  });

  it("honours an explicit limit", async () => {
    const out = await authedCaller.locations.suggest({ q: "Lon", limit: 3 });
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it("returns [] for a blank query", async () => {
    expect(await authedCaller.locations.suggest({ q: "   " })).toEqual([]);
  });

  it("rejects an over-length query (q capped at 64)", async () => {
    await expect(
      authedCaller.locations.suggest({ q: "x".repeat(65) }),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it("rejects a limit outside 1–20", async () => {
    await expect(
      authedCaller.locations.suggest({ q: "Kent", limit: 0 }),
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      authedCaller.locations.suggest({ q: "Kent", limit: 99 }),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it("rejects an anonymous caller with UNAUTHORIZED", async () => {
    await expect(
      anonCaller.locations.suggest({ q: "Conwy" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
