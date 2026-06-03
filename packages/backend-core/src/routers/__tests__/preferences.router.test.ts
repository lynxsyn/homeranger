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
    firstName: "",
    lastName: "",
    phone: "",
    urgency: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// dev@homeranger.local is the default operator → owner key null (the singleton
// the AI-matching engine reads), so the recompute trigger fires for it.
const authedCaller = appRouter.createCaller({
  user: { id: "00000000-0000-0000-0000-0000000000de", email: "dev@homeranger.local" },
});
const PARTNER_ID = "33333333-3333-4333-8333-333333333333";
const partnerCaller = appRouter.createCaller({
  user: { id: PARTNER_ID, email: "partner@homeranger.test" },
});

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

  it("forwards the buyer identity fields (Settings 'Your details')", async () => {
    const updated = makeProfile({
      firstName: "Jane",
      lastName: "Whitfield",
      phone: "07700 900123",
      urgency: "ready",
    });
    const fake = new SearchProfileRepository();
    const updateSpy = vi.spyOn(fake, "update").mockResolvedValue(updated);
    _setSearchProfileRepositoryForTesting(fake);
    _setProfileChangeTriggerForTesting(vi.fn().mockResolvedValue(0));

    const result = await authedCaller.preferences.update({
      firstName: "Jane",
      lastName: "Whitfield",
      phone: "07700 900123",
      urgency: "ready",
    });

    expect(result).toEqual(updated);
    expect(updateSpy.mock.calls[0]![0]).toMatchObject({
      firstName: "Jane",
      lastName: "Whitfield",
      phone: "07700 900123",
      urgency: "ready",
    });
  });

  it("rejects an unknown urgency (strict schema)", async () => {
    const fake = new SearchProfileRepository();
    vi.spyOn(fake, "update").mockResolvedValue(makeProfile());
    _setSearchProfileRepositoryForTesting(fake);
    _setProfileChangeTriggerForTesting(vi.fn().mockResolvedValue(0));

    await expect(
      authedCaller.preferences.update({
        // @ts-expect-error — "whenever" is not a valid urgency
        urgency: "whenever",
      }),
    ).rejects.toThrow();
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

describe("preferencesRouter multi-user scoping", () => {
  it("reads/writes the operator's NULL-namespace profile for the operator", async () => {
    const fake = new SearchProfileRepository();
    const getSpy = vi.spyOn(fake, "getOrCreate").mockResolvedValue(makeProfile());
    const updateSpy = vi.spyOn(fake, "update").mockResolvedValue(makeProfile());
    _setSearchProfileRepositoryForTesting(fake);
    const trigger = vi.fn().mockResolvedValue(0);
    _setProfileChangeTriggerForTesting(trigger);

    await authedCaller.preferences.get();
    await authedCaller.preferences.update({ freeTextPreferences: "x" });

    expect(getSpy).toHaveBeenCalledWith(null);
    expect(updateSpy.mock.calls[0]![1]).toBeNull();
    expect(trigger).toHaveBeenCalledTimes(1); // operator → recompute fires
  });

  it("scopes a non-operator to their own profile and SKIPS the global recompute", async () => {
    const fake = new SearchProfileRepository();
    const getSpy = vi.spyOn(fake, "getOrCreate").mockResolvedValue(makeProfile());
    const updateSpy = vi.spyOn(fake, "update").mockResolvedValue(makeProfile());
    _setSearchProfileRepositoryForTesting(fake);
    const trigger = vi.fn().mockResolvedValue(0);
    _setProfileChangeTriggerForTesting(trigger);

    await partnerCaller.preferences.get();
    await partnerCaller.preferences.update({ freeTextPreferences: "y" });

    expect(getSpy).toHaveBeenCalledWith(PARTNER_ID);
    expect(updateSpy.mock.calls[0]![1]).toBe(PARTNER_ID);
    // A non-operator's save stores their settings WITHOUT triggering the
    // operator-scoped global recompute.
    expect(trigger).not.toHaveBeenCalled();
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
