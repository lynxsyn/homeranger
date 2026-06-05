/**
 * Unit tests for the Claude Haiku agent-quality classifier. The Anthropic client
 * is INJECTED (no network/spend); `messages.create` is a stub.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  DefaultClaudeAgentClassifier,
  parseAgentClassify,
  shouldAutoDelete,
  type AgentClassifierConfig,
} from "./agent-classifier.provider.js";
import type { ProviderError } from "./provider-errors.js";

const CONFIG: AgentClassifierConfig = {
  apiKey: "test-key",
  model: "claude-haiku-4-5",
  maxOutputTokens: 256,
  timeoutMs: 1000,
  inputPricePencePerMTok: 80,
  outputPricePencePerMTok: 400,
};

function fakeMessage(text: string): Anthropic.Message {
  return {
    id: "msg_c",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [{ type: "text", text }],
    usage: { input_tokens: 500_000, output_tokens: 50_000 },
  } as unknown as Anthropic.Message;
}

function classifierWith(create: ReturnType<typeof vi.fn>) {
  const client = { messages: { create } } as unknown as Anthropic;
  return new DefaultClaudeAgentClassifier({ client, config: CONFIG });
}

const INPUT = {
  agencyName: "Rightmove",
  email: "noreply@onthemarket.com",
  websiteUrl: "https://onthemarket.com",
};

describe("DefaultClaudeAgentClassifier.classify", () => {
  it("round-trips a confident junk verdict and records cost", async () => {
    const create = vi.fn().mockResolvedValue(
      fakeMessage(
        JSON.stringify({
          isResidentialSalesAgency: false,
          kind: "portal",
          confidence: 0.95,
          suggestedName: "OnTheMarket",
        }),
      ),
    );
    const result = await classifierWith(create).classify(INPUT);
    expect(result.isResidentialSalesAgency).toBe(false);
    expect(result.kind).toBe("portal");
    expect(result.confidence).toBeCloseTo(0.95);
    expect(result.suggestedName).toBe("OnTheMarket");
    // 500k in @ 80p + 50k out @ 400p = 40 + 20 = 60p.
    expect(result.metrics.costPence).toBe(60);
  });

  it("clamps an out-of-range confidence into [0,1]", async () => {
    const create = vi.fn().mockResolvedValue(
      fakeMessage(
        JSON.stringify({
          isResidentialSalesAgency: false,
          kind: "portal",
          confidence: 1.8,
          suggestedName: "",
        }),
      ),
    );
    expect((await classifierWith(create).classify(INPUT)).confidence).toBe(1);
  });

  it("clamps a negative confidence up to 0", async () => {
    const create = vi.fn().mockResolvedValue(
      fakeMessage(
        JSON.stringify({
          isResidentialSalesAgency: true,
          kind: "estate_agent",
          confidence: -0.4,
          suggestedName: "",
        }),
      ),
    );
    expect((await classifierWith(create).classify(INPUT)).confidence).toBe(0);
  });

  it("treats a non-JSON response as non-retryable", async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage("nope"));
    await expect(classifierWith(create).classify(INPUT)).rejects.toMatchObject({
      retryable: false,
    } as Partial<ProviderError>);
  });

  it("classifies a 529 (overloaded) as retryable", async () => {
    const create = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("overloaded"), { status: 529 }));
    await expect(classifierWith(create).classify(INPUT)).rejects.toMatchObject({
      retryable: true,
    } as Partial<ProviderError>);
  });

  it("coalesces a null agency name to '' (FIX-2) and still classifies", async () => {
    const create = vi.fn().mockResolvedValue(
      fakeMessage(
        JSON.stringify({
          isResidentialSalesAgency: true,
          kind: "estate_agent",
          confidence: 0.9,
          suggestedName: "Acme Estates",
        }),
      ),
    );
    const result = await classifierWith(create).classify({
      agencyName: null,
      email: "info@acme-estates.co.uk",
    });
    expect(result.isResidentialSalesAgency).toBe(true);
    // The prompt must carry an empty name (not the string "null").
    const promptText = create.mock.calls[0]?.[0]?.messages?.[0]?.content?.[0]
      ?.text as string;
    expect(promptText).not.toContain("null");
  });

  it("threads page text into the prompt when present (FIX-1)", async () => {
    const create = vi.fn().mockResolvedValue(
      fakeMessage(
        JSON.stringify({
          isResidentialSalesAgency: false,
          kind: "housing_association",
          confidence: 0.95,
          suggestedName: "West Wales Housing Association",
        }),
      ),
    );
    await classifierWith(create).classify({
      agencyName: "WWHA",
      email: "info@wwha.co.uk",
      pageText: "A registered social landlord providing social housing.",
    });
    const promptText = create.mock.calls[0]?.[0]?.messages?.[0]?.content?.[0]
      ?.text as string;
    expect(promptText).toContain("registered social landlord");
  });

  it("getModel returns the configured model", () => {
    expect(classifierWith(vi.fn()).getModel()).toBe(CONFIG.model);
  });
});

describe("parseAgentClassify", () => {
  it("parses a clean verdict", () => {
    const parsed = parseAgentClassify(
      JSON.stringify({
        isResidentialSalesAgency: false,
        kind: "council",
        confidence: 0.9,
        suggestedName: "Conwy County Borough Council",
      }),
    );
    expect(parsed.isResidentialSalesAgency).toBe(false);
    expect(parsed.kind).toBe("council");
    expect(parsed.confidence).toBeCloseTo(0.9);
    expect(parsed.suggestedName).toBe("Conwy County Borough Council");
  });

  it("strips a ```json code fence before parsing", () => {
    const parsed = parseAgentClassify(
      '```json\n{"isResidentialSalesAgency":true,"kind":"estate_agent","confidence":0.7,"suggestedName":"X"}\n```',
    );
    expect(parsed.isResidentialSalesAgency).toBe(true);
    expect(parsed.confidence).toBeCloseTo(0.7);
  });

  it("KEEP-safe defaults on a MISSING verdict (no auto-delete)", () => {
    const parsed = parseAgentClassify(
      JSON.stringify({ kind: "portal", confidence: 0.99, suggestedName: "X" }),
    );
    expect(parsed.isResidentialSalesAgency).toBe(true);
    expect(parsed.confidence).toBe(0);
    expect(shouldAutoDelete(parsed)).toBe(false);
  });

  it("KEEP-safe defaults on a NON-BOOLEAN verdict (no auto-delete)", () => {
    const parsed = parseAgentClassify(
      JSON.stringify({
        isResidentialSalesAgency: "false",
        kind: "portal",
        confidence: 0.99,
        suggestedName: "X",
      }),
    );
    expect(parsed.isResidentialSalesAgency).toBe(true);
    expect(parsed.confidence).toBe(0);
    expect(shouldAutoDelete(parsed)).toBe(false);
  });

  it("defaults an unknown kind to 'other'", () => {
    const parsed = parseAgentClassify(
      JSON.stringify({
        isResidentialSalesAgency: false,
        kind: "spaceship",
        confidence: 0.9,
        suggestedName: "X",
      }),
    );
    expect(parsed.kind).toBe("other");
  });

  it("defaults a missing suggestedName to empty string", () => {
    const parsed = parseAgentClassify(
      JSON.stringify({
        isResidentialSalesAgency: false,
        kind: "portal",
        confidence: 0.9,
      }),
    );
    expect(parsed.suggestedName).toBe("");
  });

  it("throws non-retryable on invalid JSON", () => {
    expect(() => parseAgentClassify("nope")).toThrow();
    try {
      parseAgentClassify("nope");
    } catch (error) {
      expect((error as ProviderError).retryable).toBe(false);
    }
  });

  it("KEEP-safe defaults on a non-numeric confidence (no throw, no auto-delete)", () => {
    // A field-level drift must never abort the discovery batch nor auto-delete —
    // only unparseable JSON throws. A bad confidence resolves keep-safe.
    const parsed = parseAgentClassify(
      JSON.stringify({
        isResidentialSalesAgency: false,
        kind: "portal",
        confidence: "high",
        suggestedName: "X",
      }),
    );
    expect(parsed.isResidentialSalesAgency).toBe(true);
    expect(parsed.confidence).toBe(0);
    expect(shouldAutoDelete(parsed)).toBe(false);
  });
});

describe("shouldAutoDelete", () => {
  it("fires on a confident non-agency verdict", () => {
    expect(
      shouldAutoDelete({ isResidentialSalesAgency: false, confidence: 0.85 }),
    ).toBe(true);
    expect(
      shouldAutoDelete({ isResidentialSalesAgency: false, confidence: 0.99 }),
    ).toBe(true);
  });

  it("does NOT fire on an uncertain non-agency verdict", () => {
    expect(
      shouldAutoDelete({ isResidentialSalesAgency: false, confidence: 0.84 }),
    ).toBe(false);
    expect(
      shouldAutoDelete({ isResidentialSalesAgency: false, confidence: 0 }),
    ).toBe(false);
  });

  it("does NOT fire on a confident agency verdict", () => {
    expect(
      shouldAutoDelete({ isResidentialSalesAgency: true, confidence: 1 }),
    ).toBe(false);
  });

  it("honours a custom threshold", () => {
    expect(
      shouldAutoDelete(
        { isResidentialSalesAgency: false, confidence: 0.7 },
        0.6,
      ),
    ).toBe(true);
  });
});
