/**
 * Unit tests for the analyze:recompute handler (mirrors analyze-handler):
 * NON-retryable → UnrecoverableError + drop metric; retryable/unknown → rethrow.
 */
import { describe, expect, it } from "vitest";
import { UnrecoverableError } from "bullmq";
import { makeRecomputeHandler } from "./recompute-handler.js";
import { analysisDroppedTotal } from "@homescout/backend-core/lib/ai/analysis-metrics";
import type { PreferenceMatchService } from "@homescout/backend-core/services/preference-match.service";

function recomputeThrowing(error: unknown): PreferenceMatchService {
  return {
    async recompute(): Promise<never> {
      throw error;
    },
    async scoreListing() {
      return { scored: false };
    },
  };
}

async function dropMetricValue(): Promise<number> {
  const json = (await analysisDroppedTotal.get()) as { values: { value: number }[] };
  return json.values[0]?.value ?? 0;
}

describe("makeRecomputeHandler", () => {
  it("resolves when recompute succeeds", async () => {
    const handler = makeRecomputeHandler({
      preferenceMatchService: {
        async recompute() {
          return { profileEmbedded: true, candidates: 2, scored: 2 };
        },
        async scoreListing() {
          return { scored: true };
        },
      },
    });
    await expect(handler()).resolves.toBeUndefined();
  });

  it("maps a NON-retryable error to UnrecoverableError + increments the drop metric", async () => {
    const before = await dropMetricValue();
    const handler = makeRecomputeHandler({
      preferenceMatchService: recomputeThrowing(
        Object.assign(new Error("bad request"), { retryable: false }),
      ),
    });
    await expect(handler()).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await dropMetricValue()).toBe(before + 1);
  });

  it("rethrows a retryable error unchanged (BullMQ retries)", async () => {
    const transient = Object.assign(new Error("529"), { retryable: true });
    const handler = makeRecomputeHandler({
      preferenceMatchService: recomputeThrowing(transient),
    });
    await expect(handler()).rejects.toBe(transient);
    await expect(handler()).rejects.not.toBeInstanceOf(UnrecoverableError);
  });
});
