/**
 * Unit tests for the analyze:listing handler's poison-pill guard (mirrors the
 * inbound-handler tests). NON-retryable → UnrecoverableError + drop metric;
 * retryable/unknown → rethrow the original so BullMQ retries.
 */
import { describe, expect, it } from "vitest";
import { UnrecoverableError } from "bullmq";
import { makeAnalyzeHandler } from "./analyze-handler.js";
import { analysisDroppedTotal } from "@homeranger/backend-core/lib/ai/analysis-metrics";
import type { ListingAnalysisService } from "@homeranger/backend-core/services/listing-analysis.service";
import type { AnalyzeListingJobPayload } from "@homeranger/backend-core/lib/queue/queue-config";

function job(): { data: AnalyzeListingJobPayload } {
  return { data: { listingId: "11111111-1111-1111-1111-111111111111" } };
}

function analysisThrowing(error: unknown): ListingAnalysisService {
  return {
    async analyzeListing(): Promise<never> {
      throw error;
    },
  };
}

async function dropMetricValue(): Promise<number> {
  const json = (await analysisDroppedTotal.get()) as {
    values: { value: number }[];
  };
  return json.values[0]?.value ?? 0;
}

describe("makeAnalyzeHandler — retry classification", () => {
  it("succeeds (no throw) when analysis resolves", async () => {
    const handler = makeAnalyzeHandler({
      listingAnalysisService: {
        async analyzeListing(listingId: string) {
          return {
            listingId,
            skipped: false,
            photosAnalyzed: 1,
            photosSkipped: 0,
            embedded: true,
            match: { scored: true, searchesScored: 1 },
          };
        },
      },
    });
    await expect(handler(job())).resolves.toBeUndefined();
  });

  it("a NON-retryable error → UnrecoverableError (no retry) + drop metric ++", async () => {
    const before = await dropMetricValue();
    const handler = makeAnalyzeHandler({
      listingAnalysisService: analysisThrowing(
        Object.assign(new Error("listing not found"), { retryable: false }),
      ),
    });
    await expect(handler(job())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await dropMetricValue()).toBe(before + 1);
  });

  it("a RETRYABLE error → rethrows the ORIGINAL error (BullMQ retries)", async () => {
    const transient = Object.assign(new Error("529 overloaded"), {
      retryable: true,
    });
    const before = await dropMetricValue();
    const handler = makeAnalyzeHandler({
      listingAnalysisService: analysisThrowing(transient),
    });
    await expect(handler(job())).rejects.toBe(transient);
    await expect(handler(job())).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(await dropMetricValue()).toBe(before);
  });

  it("an UNKNOWN/untyped error defaults to retryable (transient-safe rethrow)", async () => {
    const plain = new Error("connection reset");
    const handler = makeAnalyzeHandler({
      listingAnalysisService: analysisThrowing(plain),
    });
    await expect(handler(job())).rejects.toBe(plain);
    await expect(handler(job())).rejects.not.toBeInstanceOf(UnrecoverableError);
  });
});
