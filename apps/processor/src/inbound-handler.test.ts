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
import { describe, expect, it, beforeEach } from "vitest";
import { UnrecoverableError } from "bullmq";
import { makeInboundHandler } from "./inbound-handler.js";
import { inboundDroppedTotal } from "@homescout/backend-core/lib/queue/queue-metrics";
import type { ResendHydrator } from "@homescout/backend-core/lib/inbound/resend-hydrator";
import type { InboundIngestionService } from "@homescout/backend-core/services/inbound-ingestion.service";
import type { InboundEmailJobPayload } from "@homescout/backend-core/lib/queue/queue-config";

function job(): { data: InboundEmailJobPayload } {
  return {
    data: {
      email_id: "email-poison-1",
      from: "agent@example.com",
      to: ["inbox@homescout.app"],
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
      recipientEmail: "inbox@homescout.app",
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
