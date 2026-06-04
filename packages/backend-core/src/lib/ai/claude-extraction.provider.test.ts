/**
 * Unit tests for the Claude extraction provider (M4 test plan, Unit: Claude
 * extractor with Anthropic mocked → structured listing + listingUrl; missing
 * fields handled). The Anthropic client is INJECTED (deps.client), so no network
 * + no vi.mock — `messages.create` is a stub returning a canned Message.
 * Also covers stripCodeFence, retryable-error classification, and the adapter's
 * attachment-block mapping.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultClaudeExtractionProvider,
  LISTING_EXTRACTION_SCHEMA,
  buildUserContent,
  createAnthropicClient,
  stripCodeFence,
  type ClaudeExtractionConfig,
  type ExtractionError,
} from "./claude-extraction.provider.js";
import { ClaudeListingExtractionAdapter } from "./listing-extraction.adapter.js";

const CONFIG: ClaudeExtractionConfig = {
  apiKey: "test-key",
  model: "claude-sonnet-4-5",
  maxOutputTokens: 1024,
  timeoutMs: 1000,
  inputPricePencePerMTok: 240,
  outputPricePencePerMTok: 1200,
};

function fakeMessage(text: string): Anthropic.Message {
  return {
    id: "msg_x",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [{ type: "text", text }],
    usage: { input_tokens: 1_000_000, output_tokens: 200_000 },
  } as unknown as Anthropic.Message;
}

function providerWith(create: ReturnType<typeof vi.fn>) {
  const client = { messages: { create } } as unknown as Anthropic;
  return new DefaultClaudeExtractionProvider({ client, config: CONFIG });
}

describe("DefaultClaudeExtractionProvider.extractListing", () => {
  it("parses a structured listing (price in pence, enums, listingUrl)", async () => {
    const create = vi.fn().mockResolvedValue(
      fakeMessage(
        JSON.stringify({
          addressRaw: "12 Acacia Avenue, London",
          postcode: "SW1A 1AA",
          outcode: "SW1A",
          pricePence: 45_000_000,
          bedrooms: 3,
          bathrooms: 2,
          tenure: "freehold",
          propertyType: "terraced",
          epcRating: "c",
          listingStatus: "pre_market",
          listingUrl: "https://rightmove.example/123",
          confidence: 0.92,
        }),
      ),
    );
    const provider = providerWith(create);
    const { listing, metrics } = await provider.extractListing({
      bodyText: "Off-market terraced house in SW1A, £450,000",
      subject: "New instruction",
    });

    expect(listing.pricePence).toBe(45_000_000);
    expect(listing.tenure).toBe("freehold");
    expect(listing.propertyType).toBe("terraced");
    expect(listing.listingUrl).toBe("https://rightmove.example/123");
    expect(metrics.inputTokens).toBe(1_000_000);
    // 1M input @ 240p/MTok + 200k output @ 1200p/MTok = 240 + 240 = 480p.
    expect(metrics.costPence).toBe(480);
  });

  it("handles missing fields (model emits nulls) and strips a code fence", async () => {
    const create = vi.fn().mockResolvedValue(
      fakeMessage(
        "```json\n" +
          JSON.stringify({
            addressRaw: null,
            postcode: null,
            outcode: null,
            pricePence: null,
            bedrooms: null,
            bathrooms: null,
            tenure: null,
            propertyType: null,
            epcRating: null,
            listingStatus: null,
            listingUrl: null,
            confidence: 0.1,
          }) +
          "\n```",
      ),
    );
    const provider = providerWith(create);
    const { listing } = await provider.extractListing({ bodyText: "ping" });
    expect(listing.addressRaw).toBeNull();
    expect(listing.pricePence).toBeNull();
    expect(listing.confidence).toBe(0.1);
  });

  it("rejects an unknown enum value to null (defensive)", async () => {
    const create = vi.fn().mockResolvedValue(
      fakeMessage(
        JSON.stringify({
          addressRaw: "x",
          postcode: null,
          outcode: null,
          pricePence: null,
          bedrooms: null,
          bathrooms: null,
          tenure: "weird_tenure",
          propertyType: null,
          epcRating: null,
          listingStatus: null,
          listingUrl: null,
          confidence: null,
        }),
      ),
    );
    const provider = providerWith(create);
    const { listing } = await provider.extractListing({ bodyText: "x" });
    expect(listing.tenure).toBeNull();
  });

  it("classifies a 429 as retryable and a 400 as non-retryable", async () => {
    const create429 = vi.fn().mockRejectedValue(
      Object.assign(new Error("rate limited"), { status: 429 }),
    );
    await expect(
      providerWith(create429).extractListing({ bodyText: "x" }),
    ).rejects.toMatchObject({ retryable: true } as Partial<ExtractionError>);

    const create400 = vi.fn().mockRejectedValue(
      Object.assign(new Error("bad request"), { status: 400 }),
    );
    await expect(
      providerWith(create400).extractListing({ bodyText: "x" }),
    ).rejects.toMatchObject({ retryable: false } as Partial<ExtractionError>);
  });

  it("classifies a 404 as NON-retryable (e.g. a misconfigured AI Gateway id)", async () => {
    // A wrong CF_AI_GATEWAY_ID makes the gateway URL 404. Treating that as
    // retryable would burn every BullMQ attempt + backoff on a permanent error.
    const create404 = vi.fn().mockRejectedValue(
      Object.assign(new Error("gateway not found"), { status: 404 }),
    );
    await expect(
      providerWith(create404).extractListing({ bodyText: "x" }),
    ).rejects.toMatchObject({ retryable: false } as Partial<ExtractionError>);
  });

  it("classifies a 408 request-timeout as retryable (transient 4xx carve-out)", async () => {
    const create408 = vi.fn().mockRejectedValue(
      Object.assign(new Error("request timeout"), { status: 408 }),
    );
    await expect(
      providerWith(create408).extractListing({ bodyText: "x" }),
    ).rejects.toMatchObject({ retryable: true } as Partial<ExtractionError>);
  });

  it("treats a non-JSON response as a non-retryable parse failure", async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage("not json at all"));
    await expect(
      providerWith(create).extractListing({ bodyText: "x" }),
    ).rejects.toMatchObject({ retryable: false } as Partial<ExtractionError>);
  });

  it("treats a response with no text block as a non-retryable failure", async () => {
    const empty = {
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Anthropic.Message;
    const create = vi.fn().mockResolvedValue(empty);
    await expect(
      providerWith(create).extractListing({ bodyText: "x" }),
    ).rejects.toMatchObject({ retryable: false } as Partial<ExtractionError>);
  });

  it("classifies a 503 as retryable (5xx) and an unknown error as retryable", async () => {
    const create503 = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("svc down"), { status: 503 }));
    await expect(
      providerWith(create503).extractListing({ bodyText: "x" }),
    ).rejects.toMatchObject({ retryable: true } as Partial<ExtractionError>);

    const createUnknown = vi.fn().mockRejectedValue(new Error("network blip"));
    await expect(
      providerWith(createUnknown).extractListing({ bodyText: "x" }),
    ).rejects.toMatchObject({ retryable: true } as Partial<ExtractionError>);
  });

  it("reads `statusCode` (SDK alt field) + `code` off the error", async () => {
    const create = vi.fn().mockRejectedValue(
      Object.assign(new Error("forbidden"), {
        statusCode: 403,
        code: "permission_denied",
      }),
    );
    await expect(
      providerWith(create).extractListing({ bodyText: "x" }),
    ).rejects.toMatchObject({
      retryable: false,
      status: 403,
      code: "permission_denied",
    } as Partial<ExtractionError>);
  });

  it("preserves an already-classified ExtractionError unchanged", async () => {
    const preclassified = Object.assign(new Error("already typed"), {
      retryable: false,
    });
    const create = vi.fn().mockRejectedValue(preclassified);
    await expect(
      providerWith(create).extractListing({ bodyText: "x" }),
    ).rejects.toBe(preclassified);
  });

  it("computes zero cost when usage is absent and resolves the configured model", async () => {
    const noUsage = {
      id: "m",
      type: "message",
      role: "assistant",
      model: "",
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            addressRaw: "x",
            postcode: null,
            outcode: null,
            pricePence: 1.7, // non-integer → rounded
            bedrooms: null,
            bathrooms: null,
            tenure: null,
            propertyType: null,
            epcRating: null,
            listingStatus: null,
            listingUrl: null,
            confidence: null,
          }),
        },
      ],
      usage: null,
    } as unknown as Anthropic.Message;
    const provider = providerWith(vi.fn().mockResolvedValue(noUsage));
    const { listing, metrics } = await provider.extractListing({ bodyText: "x" });
    expect(metrics.costPence).toBe(0);
    expect(metrics.inputTokens).toBe(0);
    // empty response model → falls back to the configured model.
    expect(metrics.model).toBe(CONFIG.model);
    expect(listing.pricePence).toBe(2); // 1.7 rounded
  });

  it("getModel returns the configured model", () => {
    expect(providerWith(vi.fn()).getModel()).toBe(CONFIG.model);
  });
});

describe("stripCodeFence", () => {
  it("unwraps a ```json fence", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("returns plain JSON untouched", () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });
});

describe("buildUserContent", () => {
  it("emits a text header block + a document block for a PDF + an image block", () => {
    const blocks = buildUserContent({
      bodyText: "body",
      subject: "subj",
      attachments: [
        { kind: "pdf", data: Buffer.from("pdf-bytes"), fileName: "brochure.pdf" },
        {
          kind: "image",
          data: Buffer.from("img-bytes"),
          mediaType: "image/png",
        },
      ],
    });
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[1]!.type).toBe("document");
    expect(blocks[2]!.type).toBe("image");
  });

  it("emits a plain text block for a pre-extracted text attachment", () => {
    const blocks = buildUserContent({
      bodyText: "body",
      attachments: [
        { kind: "text", text: "flattened pdf text", fileName: "big.pdf" },
        { kind: "text", text: "no filename text" },
      ],
    });
    expect(blocks).toHaveLength(3);
    expect(blocks[1]!.type).toBe("text");
    expect(blocks[2]!.type).toBe("text");
  });

  it("omits the document title when the PDF has no fileName, and handles no subject/from", () => {
    const blocks = buildUserContent({
      bodyText: "just a body",
      attachments: [{ kind: "pdf", data: Buffer.from("p") }],
    });
    expect(blocks[0]!.type).toBe("text");
    const doc = blocks[1] as { type: string; title?: string };
    expect(doc.type).toBe("document");
    expect(doc.title).toBeUndefined();
  });
});

describe("ClaudeListingExtractionAdapter", () => {
  it("maps DecodedAttachments to native blocks and returns the service ExtractedListing", async () => {
    const create = vi.fn().mockResolvedValue(
      fakeMessage(
        JSON.stringify({
          addressRaw: "1 Test Road",
          postcode: "SW1A 1AA",
          outcode: "SW1A",
          pricePence: 30_000_000,
          bedrooms: 2,
          bathrooms: 1,
          tenure: "leasehold",
          propertyType: "flat",
          epcRating: "b",
          listingStatus: "pre_market",
          listingUrl: null,
          confidence: 0.8,
        }),
      ),
    );
    const provider = providerWith(create);
    const adapter = new ClaudeListingExtractionAdapter(provider);

    const result = await adapter.extract({
      bodyText: "A flat",
      bodyHtml: null,
      subject: "subj",
      fromAddress: "agent@x.com",
      attachments: [
        {
          fileName: "photo.jpg",
          mimeType: "image/jpeg",
          byteSize: 9,
          buffer: Buffer.from("jpg-bytes"),
          storedUrl: "r2://b/k",
        },
      ],
    });

    expect(result.pricePence).toBe(30_000_000);
    expect(result.propertyType).toBe("flat");
    expect(result.outcode).toBe("SW1A");
    // The adapter passed exactly one image block (+ the text header) to Claude.
    const call = create.mock.calls[0]![0] as { messages: Array<{ content: unknown[] }> };
    const content = call.messages[0]!.content;
    expect(content.some((b) => (b as { type: string }).type === "image")).toBe(true);
  });
});

describe("createAnthropicClient (AI Gateway wiring)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("talks directly to Anthropic when the gateway env is unset", () => {
    const client = createAnthropicClient(CONFIG);
    expect(client.baseURL).toContain("api.anthropic.com");
  });

  it("routes through the AI Gateway base URL when CF_AI_GATEWAY_* is set", () => {
    vi.stubEnv("CF_AI_GATEWAY_ACCOUNT_ID", "acc123");
    vi.stubEnv("CF_AI_GATEWAY_ID", "homeranger");
    const client = createAnthropicClient(CONFIG);
    expect(client.baseURL).toContain(
      "gateway.ai.cloudflare.com/v1/acc123/homeranger/anthropic",
    );
  });
});

describe("LISTING_EXTRACTION_SCHEMA (Anthropic strict-schema compatibility)", () => {
  // The original schema declared nullable enums as `type:["string","null"]` WITH
  // an `enum`, which Anthropic's structured-output validator rejects (400 → every
  // extraction dropped → zero listings). They MUST be anyOf instead.
  const props = LISTING_EXTRACTION_SCHEMA.properties as Record<
    string,
    { anyOf?: unknown; enum?: unknown; type?: unknown }
  >;

  it("declares every nullable ENUM field as anyOf, never type-array + enum", () => {
    for (const field of ["tenure", "propertyType", "epcRating", "listingStatus"]) {
      const prop = props[field];
      expect(prop.anyOf).toBeDefined();
      expect(prop.enum).toBeUndefined();
      expect(Array.isArray(prop.type)).toBe(false);
    }
  });
});
