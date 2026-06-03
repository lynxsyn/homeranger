/**
 * preferencesRouter unit tests (M5). A fake SearchProfileRepository is injected
 * via `_setSearchProfileRepositoryForTesting`; the backfill trigger is swapped
 * for a spy via `_setProfileChangeTriggerForTesting`. No DB, no queue.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "../index.js";
import {
  SearchProfileRepository,
  _setSearchProfileRepositoryForTesting,
  type SearchProfileRecord,
} from "../../repositories/search-profile.repository.js";
import { _setProfileChangeTriggerForTesting } from "../preferences.router.js";

function makeProfile(overrides: Partial<SearchProfileRecord> = {}): SearchProfileRecord {
  const now = new Date("2026-06-01T00:00:00.000Z");
  return {
    id: "00000000-0000-0000-0000-000000000001",
    freeTextPreferences: "Bright modern flat near the river",
    minBedrooms: 2,
    maxPricePence: 60_000_000,
    outcodes: ["SE1"],
    requiredTenure: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const authedCaller = appRouter.createCaller({ user: { email: "dev@homeranger.local" } });

afterEach(() => {
  _setSearchProfileRepositoryForTesting(null);
  _setProfileChangeTriggerForTesting(null);
  vi.restoreAllMocks();
});

describe("preferencesRouter.get", () => {
  it("returns the single profile via getOrCreate", async () => {
    const profile = makeProfile();
    const fake = new SearchProfileRepository();
    vi.spyOn(fake, "getOrCreate").mockResolvedValue(profile);
    _setSearchProfileRepositoryForTesting(fake);

    const result = await authedCaller.preferences.get();
    expect(result).toEqual(profile);
  });
});

describe("preferencesRouter.update", () => {
  it("persists the partial update and fires the backfill trigger", async () => {
    const updated = makeProfile({ freeTextPreferences: "Quiet garden flat" });
    const fake = new SearchProfileRepository();
    const updateSpy = vi.spyOn(fake, "update").mockResolvedValue(updated);
    _setSearchProfileRepositoryForTesting(fake);

    const trigger = vi.fn().mockResolvedValue(3);
    _setProfileChangeTriggerForTesting(trigger);

    const result = await authedCaller.preferences.update({
      freeTextPreferences: "Quiet garden flat",
      minBedrooms: 3,
      outcodes: ["se1", "se16"],
    });

    expect(result).toEqual(updated);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    // outcodes are upper-cased by the shared schema on parse.
    expect(updateSpy.mock.calls[0]![0]).toMatchObject({
      freeTextPreferences: "Quiet garden flat",
      minBedrooms: 3,
      outcodes: ["SE1", "SE16"],
    });
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("still returns the updated profile when the backfill trigger throws", async () => {
    const updated = makeProfile();
    const fake = new SearchProfileRepository();
    vi.spyOn(fake, "update").mockResolvedValue(updated);
    _setSearchProfileRepositoryForTesting(fake);
    _setProfileChangeTriggerForTesting(() =>
      Promise.reject(new Error("queue down")),
    );

    const result = await authedCaller.preferences.update({
      freeTextPreferences: "x",
    });
    expect(result).toEqual(updated);
  });

  it("rejects an invalid outcode (strict schema)", async () => {
    const fake = new SearchProfileRepository();
    vi.spyOn(fake, "update").mockResolvedValue(makeProfile());
    _setSearchProfileRepositoryForTesting(fake);
    _setProfileChangeTriggerForTesting(vi.fn().mockResolvedValue(0));

    await expect(
      authedCaller.preferences.update({ outcodes: ["not-an-outcode!!"] }),
    ).rejects.toBeTruthy();
  });
});

describe("preferencesRouter auth", () => {
  it("rejects an anonymous caller with UNAUTHORIZED", async () => {
    const anon = appRouter.createCaller({ user: null });
    await expect(anon.preferences.get()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
