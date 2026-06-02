/**
 * Env-gated FAKE match re-scorer (`ANALYSIS_FAKE=1` / `MATCH_FAKE=1`). Returns a
 * DETERMINISTIC 0–1 score + rationale derived from the listing description, so
 * the E2E writes a real `ListingScore` (combinedScore + rationale) the row-expand
 * renders and the table sorts by — with no Haiku call or spend. Never in prod.
 */
import { createHash } from "node:crypto";
import type {
  MatchScoreInput,
  MatchScoreResult,
  MatchScorer,
} from "./match-scorer.provider.js";

export class FakeMatchScorer implements MatchScorer {
  private readonly model = "fake-haiku";

  getModel(): string {
    return this.model;
  }

  async scoreMatch(input: MatchScoreInput): Promise<MatchScoreResult> {
    const hex = createHash("sha256")
      .update(input.listingDescription)
      .digest("hex");
    const llmScore = (Number.parseInt(hex.slice(0, 8), 16) % 1000) / 1000; // 0–0.999
    return {
      llmScore,
      rationale: `Fake match: scored this listing ${(llmScore * 100).toFixed(
        0,
      )}/100 against your preferences.`,
      metrics: {
        model: this.model,
        inputTokens: 0,
        outputTokens: 0,
        costPence: 0,
        durationMs: 0,
      },
    };
  }
}
