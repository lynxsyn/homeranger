/**
 * Unit tests for the analyze:recompute handler. Routes on the payload's
 * `searchId` (present → recomputeSearch, absent → recomputeAll) and mirrors
 * analyze-handler's retry mapping: NON-retryable → UnrecoverableError + drop
 * metric; retryable/unknown → rethrow.
 */
import { describe, expect, it, vi } from "vitest";
import { UnrecoverableError } from "bullmq";
import { makeRecomputeHandler } from "./recompute-handler.js";
import { analysisDroppedTotal } from "@homeranger/backend-core/lib/ai/analysis-metrics";
import type { PreferenceMatchService } from "@homeranger/backend-core/services/preference-match.service";

/** A PreferenceMatchService whose recompute paths can be spied / made to throw. */
function fakeService(
  overrides: Partial<PreferenceMatchService> = {},
): PreferenceMatchService {
  return {
    async recomputeSearch() {
      return { searchEmbedded: true, candidates: 0, scored: 0 };
    },
    async recomputeAll() {
      return { searchesRecomputed: 0, scored: 0 };
    },
    async scoreListing() {
      return { scored: false, searchesScored: 0 };
    },
    ...overrides,
  };
}

async function dropMetricValue(): Promise<number> {
  const json = (await analysisDroppedTotal.get()) as { values: { value: number }[] };
  return json.values[0]?.value ?? 0;
}

describe("makeRecomputeHandler routing", () => {
  it("routes a payload WITH searchId to recomputeSearch (not recomputeAll)", async () => {
    const recomputeSearch = vi
      .fn()
      .mockResolvedValue({ searchEmbedded: true, candidates: 2, scored: 2 });
    const recomputeAll = vi
      .fn()
      .mockResolvedValue({ searchesRecomputed: 0, scored: 0 });
    const handler = makeRecomputeHandler({
      preferenceMatchService: fakeService({ recomputeSearch, recomputeAll }),
    });

    await handler({ data: { searchId: "search-1" } });

    expect(recomputeSearch).toHaveBeenCalledWith("search-1");
    expect(recomputeAll).not.toHaveBeenCalled();
  });

  it("routes a payload WITHOUT searchId to recomputeAll", async () => {
    const recomputeSearch = vi.fn();
    const recomputeAll = vi
      .fn()
      .mockResolvedValue({ searchesRecomputed: 3, scored: 9 });
    const handler = makeRecomputeHandler({
      preferenceMatchService: fakeService({ recomputeSearch, recomputeAll }),
    });

    await handler({ data: { reason: "profile-updated" } });

    expect(recomputeAll).toHaveBeenCalledTimes(1);
    expect(recomputeSearch).not.toHaveBeenCalled();
  });
});

describe("makeRecomputeHandler retry mapping", () => {
  it("resolves when recompute succeeds", async () => {
    const handler = makeRecomputeHandler({ preferenceMatchService: fakeService() });
    await expect(handler({ data: {} })).resolves.toBeUndefined();
  });

  it("maps a NON-retryable error to UnrecoverableError + increments the drop metric", async () => {
    const before = await dropMetricValue();
    const handler = makeRecomputeHandler({
      preferenceMatchService: fakeService({
        recomputeAll: () =>
          Promise.reject(Object.assign(new Error("bad request"), { retryable: false })),
      }),
    });
    await expect(handler({ data: {} })).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await dropMetricValue()).toBe(before + 1);
  });

  it("rethrows a retryable error unchanged (BullMQ retries)", async () => {
    const transient = Object.assign(new Error("529"), { retryable: true });
    const handler = makeRecomputeHandler({
      preferenceMatchService: fakeService({
        recomputeSearch: () => Promise.reject(transient),
      }),
    });
    await expect(handler({ data: { searchId: "s" } })).rejects.toBe(transient);
    await expect(
      handler({ data: { searchId: "s" } }),
    ).rejects.not.toBeInstanceOf(UnrecoverableError);
  });
});
