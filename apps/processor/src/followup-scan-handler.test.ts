import { describe, expect, it, vi } from "vitest";
import { makeFollowupScanHandler } from "./followup-scan-handler.js";
import type { OutreachRepository } from "@homescout/backend-core/repositories/outreach.repository";

const NOW = new Date("2026-06-10T00:00:00Z");

function makeHandler(due: Array<{ id: string }>) {
  const listFollowupDue = vi.fn().mockResolvedValue(due);
  const enqueueFollowup = vi.fn().mockResolvedValue(undefined);
  const handler = makeFollowupScanHandler({
    outreachRepository: { listFollowupDue } as unknown as OutreachRepository,
    enqueueFollowup,
    followupCadenceHours: 72,
    now: () => NOW,
  });
  return { handler, listFollowupDue, enqueueFollowup };
}

describe("makeFollowupScanHandler", () => {
  it("enqueues one outreach:followup per due thread, keyed per (thread, UTC-day)", async () => {
    const { handler, listFollowupDue, enqueueFollowup } = makeHandler([
      { id: "t1" },
      { id: "t2" },
    ]);
    await handler({ data: {} });

    // cutoff = NOW - 72h
    expect(listFollowupDue).toHaveBeenCalledWith(
      expect.objectContaining({ cutoff: new Date("2026-06-07T00:00:00Z") }),
    );
    expect(enqueueFollowup).toHaveBeenCalledTimes(2);
    expect(enqueueFollowup).toHaveBeenNthCalledWith(1, {
      idempotencyKey: "outreach:followup:t1:2026-06-10",
      payload: { threadId: "t1" },
    });
    expect(enqueueFollowup).toHaveBeenNthCalledWith(2, {
      idempotencyKey: "outreach:followup:t2:2026-06-10",
      payload: { threadId: "t2" },
    });
  });

  it("does nothing when no threads are due", async () => {
    const { handler, enqueueFollowup } = makeHandler([]);
    await handler({ data: {} });
    expect(enqueueFollowup).not.toHaveBeenCalled();
  });
});
