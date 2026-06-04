/**
 * Unit tests for the outreach:inbound handler's poison-pill guard (M4 review fix
 * — HIGH: worker ignored the `retryable` flag, so a non-retryable email burned
 * all 3 BullMQ retries and re-billed Claude 3×).
 *
 * The handler now honours the flag:
 *   - NON-retryable → throws BullMQ's UnrecoverableError so the job fails after
 *     ONE attempt (no further Claude calls) + increments the drop metric.
 *   - retryable / unknown → rethrows the ORIGINAL error so BullMQ retries.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { UnrecoverableError } from "bullmq";
import { makeInboundHandler } from "./inbound-handler.js";
import { inboundDroppedTotal } from "@homeranger/backend-core/lib/queue/queue-metrics";
import type { ResendHydrator } from "@homeranger/backend-core/lib/inbound/resend-hydrator";
import type {
  InboundIngestionService,
  IngestInboundEmailResult,
} from "@homeranger/backend-core/services/inbound-ingestion.service";
import type { OutreachReplyService } from "@homeranger/backend-core/services/outreach-reply.service";
import type { InboundEmailJobPayload } from "@homeranger/backend-core/lib/queue/queue-config";

const INGEST_RESULT: IngestInboundEmailResult = {
  listingId: "listing-1",
  created: true,
  matchedBy: null,
  sourceRecordId: "sr-1",
};

function ingestionOk(): InboundIngestionService {
  return {
    async ingestInboundEmail(): Promise<IngestInboundEmailResult> {
      return INGEST_RESULT;
    },
  };
}

function job(): { data: InboundEmailJobPayload } {
  return {
    data: {
      email_id: "email-poison-1",
      from: "agent@example.com",
      to: ["inbox@homeranger.app"],
      attachments: [],
    },
  };
}

/** A hydrator that returns a minimal hydrated payload (ingestion throws). */
const okHydrator = {
  async hydrate() {
    return {
      messageId: "email-poison-1",
      receivedAt: new Date(),
      recipientEmail: "inbox@homeranger.app",
      senderEmail: "agent@example.com",
      senderName: null,
      subject: null,
      bodyText: "x",
      bodyHtml: null,
      spfVerdict: "pass" as const,
      dkimVerdict: "pass" as const,
      attachments: [],
    };
  },
} as unknown as ResendHydrator;

function ingestionThrowing(error: unknown): InboundIngestionService {
  return {
    async ingestInboundEmail(): Promise<never> {
      throw error;
    },
  };
}

async function dropMetricValue(): Promise<number> {
  const json = (await inboundDroppedTotal.get()) as {
    values: { value: number }[];
  };
  return json.values[0]?.value ?? 0;
}

describe("makeInboundHandler — retry classification", () => {
  beforeEach(() => {
    // No reset() available cross-test; we diff the counter instead.
  });

  it("a NON-retryable error → UnrecoverableError (no retry) + drop metric ++", async () => {
    const before = await dropMetricValue();
    const handler = makeInboundHandler({
      hydrator: okHydrator,
      inboundIngestionService: ingestionThrowing(
        Object.assign(new Error("malformed Claude JSON"), { retryable: false }),
      ),
    });

    await expect(handler(job())).rejects.toBeInstanceOf(UnrecoverableError);

    const after = await dropMetricValue();
    expect(after).toBe(before + 1);
  });

  it("a RETRYABLE error → rethrows the ORIGINAL error (BullMQ retries)", async () => {
    const transient = Object.assign(new Error("429 rate limited"), {
      retryable: true,
    });
    const before = await dropMetricValue();
    const handler = makeInboundHandler({
      hydrator: okHydrator,
      inboundIngestionService: ingestionThrowing(transient),
    });

    await expect(handler(job())).rejects.toBe(transient);
    // Not a poison pill → NOT counted as dropped, NOT an UnrecoverableError.
    await expect(handler(job())).rejects.not.toBeInstanceOf(UnrecoverableError);
    const after = await dropMetricValue();
    expect(after).toBe(before);
  });

  it("an UNKNOWN/untyped error defaults to retryable (transient-safe rethrow)", async () => {
    const plain = new Error("connection reset");
    const handler = makeInboundHandler({
      hydrator: okHydrator,
      inboundIngestionService: ingestionThrowing(plain),
    });

    await expect(handler(job())).rejects.toBe(plain);
    await expect(handler(job())).rejects.not.toBeInstanceOf(UnrecoverableError);
  });
});

describe("makeInboundHandler — M6 opt-out + reply linking", () => {
  it("runs handleOptOut, then links the reply after a successful ingest", async () => {
    const handleOptOut = vi.fn().mockResolvedValue(undefined);
    const linkReply = vi.fn().mockResolvedValue(undefined);
    const handler = makeInboundHandler({
      hydrator: okHydrator,
      inboundIngestionService: ingestionOk(),
      outreachReplyService: {
        handleOptOut,
        linkReply,
      } as unknown as OutreachReplyService,
    });
    await handler(job());
    expect(handleOptOut).toHaveBeenCalledTimes(1);
    expect(linkReply.mock.calls[0]![1]).toEqual(INGEST_RESULT);
  });

  it("does NOT swallow a handleOptOut failure — the compliance opt-out must retry (and ingest is skipped, no Claude re-bill)", async () => {
    const boom = new Error("db blip");
    const handleOptOut = vi.fn().mockRejectedValue(boom);
    const ingest = vi.fn();
    const linkReply = vi.fn();
    const handler = makeInboundHandler({
      hydrator: okHydrator,
      inboundIngestionService: {
        ingestInboundEmail: ingest,
      } as unknown as InboundIngestionService,
      outreachReplyService: {
        handleOptOut,
        linkReply,
      } as unknown as OutreachReplyService,
    });
    await expect(handler(job())).rejects.toBe(boom);
    expect(ingest).not.toHaveBeenCalled();
    expect(linkReply).not.toHaveBeenCalled();
  });

  it("swallows a reply-LINK failure (best-effort — does not fail the job)", async () => {
    const handleOptOut = vi.fn().mockResolvedValue(undefined);
    const linkReply = vi.fn().mockRejectedValue(new Error("link blip"));
    const handler = makeInboundHandler({
      hydrator: okHydrator,
      inboundIngestionService: ingestionOk(),
      outreachReplyService: {
        handleOptOut,
        linkReply,
      } as unknown as OutreachReplyService,
    });
    await expect(handler(job())).resolves.toBeUndefined();
    expect(linkReply).toHaveBeenCalledTimes(1);
  });
});

function hydratorWith(
  bodyText: string,
  attachments: unknown[] = [],
): ResendHydrator {
  return {
    async hydrate() {
      return {
        messageId: "email-1",
        receivedAt: new Date(),
        recipientEmail: "inbox@homeranger.app",
        senderEmail: "agent@example.com",
        senderName: null,
        subject: null,
        bodyText,
        bodyHtml: null,
        spfVerdict: "pass" as const,
        dkimVerdict: "pass" as const,
        attachments,
      };
    },
  } as unknown as ResendHydrator;
}

function freshReply(): {
  handleOptOut: ReturnType<typeof vi.fn>;
  linkReply: ReturnType<typeof vi.fn>;
} {
  return {
    handleOptOut: vi.fn().mockResolvedValue(undefined),
    linkReply: vi.fn().mockResolvedValue(undefined),
  };
}

describe("makeInboundHandler — budget guardrail: gate the paid extraction", () => {
  it("SKIPS extraction for an opt-out reply, but STILL records it (linkReply, null result)", async () => {
    const ingest = vi.fn();
    const reply = freshReply();
    const handler = makeInboundHandler({
      hydrator: hydratorWith(
        "Please unsubscribe me\n\nOn Jun 4 Bryan wrote:\n> quoted",
      ),
      inboundIngestionService: {
        ingestInboundEmail: ingest,
      } as unknown as InboundIngestionService,
      outreachReplyService: reply as unknown as OutreachReplyService,
    });
    await handler(job());
    expect(ingest).not.toHaveBeenCalled();
    // The reply is still linked to its thread (so an opt-out closes it + is
    // recorded) — only the paid extraction was skipped, hence a null result.
    expect(reply.linkReply).toHaveBeenCalledTimes(1);
    expect(reply.linkReply.mock.calls[0]![1]).toBeNull();
  });

  it("SKIPS extraction for an empty reply (all quoted history), but STILL records it", async () => {
    const ingest = vi.fn();
    const reply = freshReply();
    const handler = makeInboundHandler({
      hydrator: hydratorWith(
        "On Jun 4 Bryan wrote:\n> only the quote, no new text",
      ),
      inboundIngestionService: {
        ingestInboundEmail: ingest,
      } as unknown as InboundIngestionService,
      outreachReplyService: reply as unknown as OutreachReplyService,
    });
    await handler(job());
    expect(ingest).not.toHaveBeenCalled();
    expect(reply.linkReply).toHaveBeenCalledTimes(1);
    expect(reply.linkReply.mock.calls[0]![1]).toBeNull();
  });

  it("still INGESTS an empty reply that carries an attachment (a PDF may hold a listing)", async () => {
    const ingest = vi.fn().mockResolvedValue(INGEST_RESULT);
    const reply = freshReply();
    const handler = makeInboundHandler({
      hydrator: hydratorWith("On Jun 4 Bryan wrote:\n> quote", [{ kind: "pdf" }]),
      inboundIngestionService: {
        ingestInboundEmail: ingest,
      } as unknown as InboundIngestionService,
      outreachReplyService: reply as unknown as OutreachReplyService,
    });
    await handler(job());
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(reply.linkReply.mock.calls[0]![1]).toEqual(INGEST_RESULT);
  });

  it("INGESTS a normal reply with real content", async () => {
    const ingest = vi.fn().mockResolvedValue(INGEST_RESULT);
    const reply = freshReply();
    const handler = makeInboundHandler({
      hydrator: hydratorWith("Yes, here is one: 12 Gay St, Bath, £625k"),
      inboundIngestionService: {
        ingestInboundEmail: ingest,
      } as unknown as InboundIngestionService,
      outreachReplyService: reply as unknown as OutreachReplyService,
    });
    await handler(job());
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(reply.linkReply.mock.calls[0]![1]).toEqual(INGEST_RESULT);
  });

  it("SKIPS extraction when EXTRACTION_KILL_SWITCH is set (even a real listing), but STILL records the reply", async () => {
    const prev = process.env.EXTRACTION_KILL_SWITCH;
    process.env.EXTRACTION_KILL_SWITCH = "1";
    try {
      const ingest = vi.fn();
      const reply = freshReply();
      const handler = makeInboundHandler({
        hydrator: hydratorWith("Yes, here is one: 12 Gay St, Bath, £625k"),
        inboundIngestionService: {
          ingestInboundEmail: ingest,
        } as unknown as InboundIngestionService,
        outreachReplyService: reply as unknown as OutreachReplyService,
      });
      await handler(job());
      expect(ingest).not.toHaveBeenCalled();
      expect(reply.linkReply).toHaveBeenCalledTimes(1);
      expect(reply.linkReply.mock.calls[0]![1]).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.EXTRACTION_KILL_SWITCH;
      else process.env.EXTRACTION_KILL_SWITCH = prev;
    }
  });
});
