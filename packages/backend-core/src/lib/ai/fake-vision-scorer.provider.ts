/**
 * Env-gated FAKE vision scorer (`ANALYSIS_FAKE=1` / `VISION_FAKE=1`). Returns a
 * DETERMINISTIC tasteScore + features derived from the photo bytes, so the E2E
 * persists a real `PhotoAnalysis` row the row-expand renders — with no Haiku
 * call or spend. Never used in production.
 */
import { createHash } from "node:crypto";
import type {
  PhotoScoreInput,
  PhotoScoreResult,
  VisionScorer,
} from "./vision-scorer.provider.js";

const STYLES = ["modern", "period", "minimalist", "characterful"];
const LIGHT = ["bright", "moderate", "dim"];

export class FakeVisionScorer implements VisionScorer {
  private readonly model = "fake-haiku";

  getModel(): string {
    return this.model;
  }

  async scorePhoto(input: PhotoScoreInput): Promise<PhotoScoreResult> {
    const hex = createHash("sha256").update(input.data).digest("hex");
    const n = Number.parseInt(hex.slice(0, 8), 16);
    const tasteScore = n % 101; // 0–100
    return {
      tasteScore,
      features: {
        style: STYLES[n % STYLES.length]!,
        condition: tasteScore >= 50 ? "good" : "dated",
        naturalLight: LIGHT[n % LIGHT.length]!,
        outdoorSpace: n % 2 === 0 ? "garden" : "none",
        highlights: ["fake-feature"],
      },
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
