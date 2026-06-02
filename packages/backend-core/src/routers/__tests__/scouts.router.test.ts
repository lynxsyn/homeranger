/**
 * scoutsRouter unit tests (M8). Pure unit: a fake ScoutRepository is injected
 * via `_setScoutRepositoryForTesting`, and procedures are invoked through a
 * caller built with `appRouter.createCaller({ user })`. No DB.
 *
 * Asserts:
 *   - list / getById / create / update / delete / setStatus each map their
 *     input onto the repository and return its result.
 *   - getById + update map a missing id to TRPCError NOT_FOUND.
 *   - create / update forward the wire fields (outcodes are NOT passed — the
 *     repository derives them from location) and coerce optional nullable
 *     numerics to null.
 *   - protectedProcedure rejects an anonymous caller with UNAUTHORIZED.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { appRouter } from "../index.js";
import {
  ScoutRepository,
  _setScoutRepositoryForTesting,
  type ScoutRecord,
} from "../../repositories/scout.repository.js";

function makeScout(overrides: Partial<ScoutRecord> = {}): ScoutRecord {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "00000000-0000-7000-8000-000000000001",
    name: "Conwy coast",
    location: "Conwy County",
    outcodes: ["LL30", "LL31"],
    types: ["Cottage"],
    condition: ["Restoration project"],
    land: [],
    saleMethods: ["Private treaty"],
    minBedrooms: 3,
    maxPricePence: 42_500_000,
    keywords: "sea views, character",
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const authedCaller = appRouter.createCaller({
  user: { email: "dev@homescout.local" },
});

afterEach(() => {
  _setScoutRepositoryForTesting(null);
  vi.restoreAllMocks();
});

function injectRepo(): ScoutRepository {
  const fake = new ScoutRepository();
  _setScoutRepositoryForTesting(fake);
  return fake;
}

describe("scoutsRouter.list", () => {
  it("returns every scout from the repository", async () => {
    const fake = injectRepo();
    const scouts = [makeScout(), makeScout({ id: "00000000-0000-7000-8000-000000000002" })];
    const spy = vi.spyOn(fake, "list").mockResolvedValue(scouts);

    const result = await authedCaller.scouts.list();
    expect(result).toEqual(scouts);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("scoutsRouter.getById", () => {
  it("returns the scout", async () => {
    const fake = injectRepo();
    const scout = makeScout();
    vi.spyOn(fake, "getById").mockResolvedValue(scout);

    const result = await authedCaller.scouts.getById({ id: scout.id });
    expect(result).toEqual(scout);
  });

  it("throws TRPCError NOT_FOUND on an unknown id", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(null);

    await expect(
      authedCaller.scouts.getById({
        id: "00000000-0000-7000-8000-0000000000ff",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("scoutsRouter.create", () => {
  it("maps the wire fields to the repository (no outcodes passed) and returns the row", async () => {
    const fake = injectRepo();
    const created = makeScout();
    const spy = vi.spyOn(fake, "create").mockResolvedValue(created);

    const result = await authedCaller.scouts.create({
      name: "Conwy coast",
      location: "Conwy County",
      types: ["Cottage"],
      condition: ["Restoration project"],
      land: [],
      saleMethods: ["Private treaty"],
      minBedrooms: 3,
      maxPricePence: 42_500_000,
      keywords: "sea views, character",
      status: "active",
    });

    expect(result).toEqual(created);
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0]![0];
    // The router forwards the brief verbatim and never sets outcodes (the
    // repository derives them from `location`).
    expect(arg).not.toHaveProperty("outcodes");
    expect(arg).toMatchObject({
      name: "Conwy coast",
      location: "Conwy County",
      types: ["Cottage"],
      condition: ["Restoration project"],
      land: [],
      saleMethods: ["Private treaty"],
      minBedrooms: 3,
      maxPricePence: 42_500_000,
      keywords: "sea views, character",
      status: "active",
    });
  });

  it("coerces an omitted minBedrooms/maxPricePence to null", async () => {
    const fake = injectRepo();
    const spy = vi.spyOn(fake, "create").mockResolvedValue(makeScout());

    await authedCaller.scouts.create({ name: "Anywhere" });

    const arg = spy.mock.calls[0]![0];
    expect(arg.minBedrooms).toBeNull();
    expect(arg.maxPricePence).toBeNull();
    // Wire-schema defaults flowed through.
    expect(arg.location).toBe("");
    expect(arg.types).toEqual([]);
    expect(arg.saleMethods).toEqual(["Private treaty"]);
    expect(arg.status).toBe("active");
  });
});

describe("scoutsRouter.update", () => {
  it("updates an existing scout and returns the row", async () => {
    const fake = injectRepo();
    const existing = makeScout();
    const updated = makeScout({ name: "Renamed" });
    vi.spyOn(fake, "getById").mockResolvedValue(existing);
    const updateSpy = vi.spyOn(fake, "update").mockResolvedValue(updated);

    const result = await authedCaller.scouts.update({
      id: existing.id,
      name: "Renamed",
      location: "Conwy County",
      types: ["Cottage"],
      condition: [],
      land: [],
      saleMethods: ["Private treaty"],
      minBedrooms: null,
      maxPricePence: null,
      keywords: "",
      status: "paused",
    });

    expect(result).toEqual(updated);
    const arg = updateSpy.mock.calls[0]![0];
    expect(arg).not.toHaveProperty("outcodes");
    expect(arg).toMatchObject({ id: existing.id, name: "Renamed", status: "paused" });
  });

  it("throws TRPCError NOT_FOUND when the id does not exist (and does not call update)", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "getById").mockResolvedValue(null);
    const updateSpy = vi.spyOn(fake, "update");

    await expect(
      authedCaller.scouts.update({
        id: "00000000-0000-7000-8000-0000000000ff",
        name: "Ghost",
        location: "",
        types: [],
        condition: [],
        land: [],
        saleMethods: ["Private treaty"],
        minBedrooms: null,
        maxPricePence: null,
        keywords: "",
        status: "active",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe("scoutsRouter.delete", () => {
  it("deletes by id and echoes { id }", async () => {
    const fake = injectRepo();
    const id = "00000000-0000-7000-8000-000000000001";
    const spy = vi.spyOn(fake, "delete").mockResolvedValue({ id });

    const result = await authedCaller.scouts.delete({ id });
    expect(result).toEqual({ id });
    expect(spy).toHaveBeenCalledWith(id);
  });

  it("maps Prisma P2025 (already gone) to NOT_FOUND", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "delete").mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Record not found", {
        code: "P2025",
        clientVersion: "test",
      }),
    );
    await expect(
      authedCaller.scouts.delete({ id: "00000000-0000-7000-8000-0000000000ff" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("scoutsRouter.setStatus", () => {
  it("maps id + status to the repository and returns the row", async () => {
    const fake = injectRepo();
    const paused = makeScout({ status: "paused" });
    const spy = vi.spyOn(fake, "setStatus").mockResolvedValue(paused);

    const result = await authedCaller.scouts.setStatus({
      id: paused.id,
      status: "paused",
    });
    expect(result).toEqual(paused);
    expect(spy).toHaveBeenCalledWith(paused.id, "paused");
  });

  it("maps Prisma P2025 (already gone) to NOT_FOUND", async () => {
    const fake = injectRepo();
    vi.spyOn(fake, "setStatus").mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Record not found", {
        code: "P2025",
        clientVersion: "test",
      }),
    );
    await expect(
      authedCaller.scouts.setStatus({
        id: "00000000-0000-7000-8000-0000000000ff",
        status: "paused",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("scoutsRouter auth", () => {
  it("rejects an anonymous caller with UNAUTHORIZED", async () => {
    const anon = appRouter.createCaller({ user: null });
    await expect(anon.scouts.list()).rejects.toBeInstanceOf(TRPCError);
    await expect(anon.scouts.list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
