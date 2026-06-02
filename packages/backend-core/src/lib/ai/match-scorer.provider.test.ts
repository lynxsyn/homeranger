/**
 * Unit tests for the Claude Haiku preference match re-scorer. The Anthropic
 * client is INJECTED (no network/spend); `messages.create` is a stub.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  DefaultClaudeMatchScorer,
  parseMatchScore,
  type MatchScorerConfig,
} from "./match-scorer.provider.js";
import type { ProviderError } from "./provider-errors.js";

const CONFIG: MatchScorerConfig = {
  apiKey: "test-key",
  model: "claude-haiku-4-5",
  maxOutputTokens: 512,
  timeoutMs: 1000,
  inputPricePencePerMTok: 80,
  outputPricePencePerMTok: 400,
};

function fakeMessage(text: string): Anthropic.Message {
  return {
    id: "msg_m",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [{ type: "text", text }],
    usage: { input_tokens: 500_000, output_tokens: 50_000 },
  } as unknown as Anthropic.Message;
}

function scorerWith(create: ReturnType<typeof vi.fn>) {
  const client = { messages: { create } } as unknown as Anthropic;
  return new DefaultClaudeMatchScorer({ client, config: CONFIG });
}

const INPUT = {
  profileText: "Bright modern 2-bed flat near the river, garden a plus.",
  listingDescription: "2 bed flat, SE1, £510,000, modern, bright, with a garden.",
};

describe("DefaultClaudeMatchScorer.scoreMatch", () => {
  it("returns a 0–1 score + rationale and records cost", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        fakeMessage(
          JSON.stringify({ score: 0.87, rationale: "Modern, bright, has a garden." }),
        ),
      );
    const result = await scorerWith(create).scoreMatch(INPUT);
    expect(result.llmScore).toBeCloseTo(0.87);
    expect(result.rationale).toContain("garden");
    // 500k in @ 80p + 50k out @ 400p = 40 + 20 = 60p.
    expect(result.metrics.costPence).toBe(60);
  });

  it("clamps an out-of-range score into 0–1", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(fakeMessage(JSON.stringify({ score: 1.8, rationale: "x" })));
    expect((await scorerWith(create).scoreMatch(INPUT)).llmScore).toBe(1);
  });

  it("treats a non-JSON response as non-retryable", async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage("nope"));
    await expect(scorerWith(create).scoreMatch(INPUT)).rejects.toMatchObject({
      retryable: false,
    } as Partial<ProviderError>);
  });

  it("classifies a 529 (overloaded) as retryable", async () => {
    const create = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("overloaded"), { status: 529 }));
    await expect(scorerWith(create).scoreMatch(INPUT)).rejects.toMatchObject({
      retryable: true,
    } as Partial<ProviderError>);
  });

  it("getModel returns the configured model", () => {
    expect(scorerWith(vi.fn()).getModel()).toBe(CONFIG.model);
  });
});

describe("parseMatchScore", () => {
  it("defaults a missing rationale to empty string", () => {
    expect(parseMatchScore(JSON.stringify({ score: 0.5 })).rationale).toBe("");
  });
});
