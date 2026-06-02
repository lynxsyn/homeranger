/**
 * Unit tests for the Claude Haiku vision scorer (M5 test plan, Unit row 1:
 * photo → tasteScore 0–100 + features; costPence recorded). The Anthropic
 * client is INJECTED, so no network/spend — `messages.create` is a stub.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  DefaultClaudeVisionScorer,
  parsePhotoScore,
  type VisionScorerConfig,
} from "./vision-scorer.provider.js";
import type { ProviderError } from "./provider-errors.js";

const CONFIG: VisionScorerConfig = {
  apiKey: "test-key",
  model: "claude-haiku-4-5",
  maxOutputTokens: 1024,
  timeoutMs: 1000,
  inputPricePencePerMTok: 80,
  outputPricePencePerMTok: 400,
};

function fakeMessage(text: string, usage?: Anthropic.Usage | null): Anthropic.Message {
  return {
    id: "msg_v",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [{ type: "text", text }],
    usage: usage === undefined ? { input_tokens: 1_000_000, output_tokens: 100_000 } : usage,
  } as unknown as Anthropic.Message;
}

function scorerWith(create: ReturnType<typeof vi.fn>) {
  const client = { messages: { create } } as unknown as Anthropic;
  return new DefaultClaudeVisionScorer({ client, config: CONFIG });
}

const PHOTO = {
  data: Buffer.from("jpeg-bytes"),
  mediaType: "image/jpeg" as const,
  context: "2 bed flat, SE1",
};

describe("DefaultClaudeVisionScorer.scorePhoto", () => {
  it("returns a 0–100 tasteScore + structured features and records cost", async () => {
    const create = vi.fn().mockResolvedValue(
      fakeMessage(
        JSON.stringify({
          tasteScore: 82,
          features: {
            style: "modern",
            condition: "excellent",
            naturalLight: "bright",
            outdoorSpace: "garden",
            highlights: ["bay window", "wood floors"],
          },
        }),
      ),
    );
    const result = await scorerWith(create).scorePhoto(PHOTO);

    expect(result.tasteScore).toBe(82);
    expect(result.features.style).toBe("modern");
    expect(result.features.highlights).toEqual(["bay window", "wood floors"]);
    expect(result.metrics.inputTokens).toBe(1_000_000);
    // 1M in @ 80p + 100k out @ 400p = 80 + 40 = 120p.
    expect(result.metrics.costPence).toBe(120);

    // Sent exactly one image block + a text block to Haiku.
    const call = create.mock.calls[0]![0] as {
      model: string;
      messages: Array<{ content: Array<{ type: string }> }>;
    };
    expect(call.model).toBe("claude-haiku-4-5");
    const types = call.messages[0]!.content.map((b) => b.type);
    expect(types).toContain("image");
    expect(types).toContain("text");
  });

  it("clamps an out-of-range score and tolerates a missing features object", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(fakeMessage(JSON.stringify({ tasteScore: 250 })));
    const result = await scorerWith(create).scorePhoto(PHOTO);
    expect(result.tasteScore).toBe(100);
    expect(result.features.style).toBeNull();
    expect(result.features.highlights).toEqual([]);
  });

  it("treats a non-JSON response as a non-retryable parse failure", async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage("definitely not json"));
    await expect(scorerWith(create).scorePhoto(PHOTO)).rejects.toMatchObject({
      retryable: false,
    } as Partial<ProviderError>);
  });

  it("treats a response missing tasteScore as non-retryable", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(fakeMessage(JSON.stringify({ features: {} })));
    await expect(scorerWith(create).scorePhoto(PHOTO)).rejects.toMatchObject({
      retryable: false,
    } as Partial<ProviderError>);
  });

  it("classifies a 429 as retryable and a 404 as non-retryable", async () => {
    const c429 = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("rate"), { status: 429 }));
    await expect(scorerWith(c429).scorePhoto(PHOTO)).rejects.toMatchObject({
      retryable: true,
    } as Partial<ProviderError>);

    const c404 = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("missing gateway"), { status: 404 }));
    await expect(scorerWith(c404).scorePhoto(PHOTO)).rejects.toMatchObject({
      retryable: false,
    } as Partial<ProviderError>);
  });

  it("computes zero cost when usage is absent", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(fakeMessage(JSON.stringify({ tasteScore: 40, features: {} }), null));
    const result = await scorerWith(create).scorePhoto(PHOTO);
    expect(result.metrics.costPence).toBe(0);
    expect(result.tasteScore).toBe(40);
  });

  it("getModel returns the configured model", () => {
    expect(scorerWith(vi.fn()).getModel()).toBe(CONFIG.model);
  });
});

describe("parsePhotoScore", () => {
  it("unwraps a code fence and filters non-string highlights", () => {
    const parsed = parsePhotoScore(
      "```json\n" +
        JSON.stringify({
          tasteScore: 55.6,
          features: { highlights: ["ok", 3, null, "fine"] },
        }) +
        "\n```",
    );
    expect(parsed.tasteScore).toBe(56); // rounded
    expect(parsed.features.highlights).toEqual(["ok", "fine"]);
  });
});
