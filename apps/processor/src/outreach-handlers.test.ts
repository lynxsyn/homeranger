import { describe, expect, it, vi } from "vitest";
import { UnrecoverableError } from "bullmq";
import { ComplianceError } from "@homeranger/backend-core/lib/compliance/compliance-guard";
import type { OutreachService } from "@homeranger/backend-core/services/outreach.service";
import type { WarmupService } from "@homeranger/backend-core/services/warmup.service";
import { makeOutreachSendHandler } from "./outreach-send-handler.js";
import { makeOutreachFollowupHandler } from "./outreach-followup-handler.js";
import { makeWarmupRecalcHandler } from "./warmup-recalc-handler.js";

function sendService(impl: () => Promise<unknown>): OutreachService {
  return {
    sendOutreach: vi.fn(impl),
    sendFollowup: vi.fn(impl),
  } as unknown as OutreachService;
}

describe("makeOutreachSendHandler", () => {
  it("delegates a successful send to OutreachService.sendOutreach", async () => {
    const service = sendService(async () => ({}));
    const handler = makeOutreachSendHandler({ outreachService: service });
    await handler({ data: { agentId: "agent-1" } });
    expect(service.sendOutreach).toHaveBeenCalledWith({ agentId: "agent-1" });
  });

  it("passes searchId through when the job carries one", async () => {
    const service = sendService(async () => ({}));
    const handler = makeOutreachSendHandler({ outreachService: service });
    await handler({ data: { agentId: "agent-1", searchId: "search-7" } });
    expect(service.sendOutreach).toHaveBeenCalledWith({
      agentId: "agent-1",
      searchId: "search-7",
    });
  });

  it("omits searchId when the job has none (generic draft path)", async () => {
    const service = sendService(async () => ({}));
    const handler = makeOutreachSendHandler({ outreachService: service });
    await handler({ data: { agentId: "agent-1" } });
    expect(service.sendOutreach).toHaveBeenCalledWith({ agentId: "agent-1" });
    const arg = (service.sendOutreach as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(arg).not.toHaveProperty("searchId");
  });

  it("DROPS the job (UnrecoverableError) on a non-retryable ComplianceError", async () => {
    const service = sendService(async () => {
      throw new ComplianceError("SUPPRESSED", {
        retryable: false,
        trpcCode: "FORBIDDEN",
      });
    });
    const handler = makeOutreachSendHandler({ outreachService: service });
    await expect(handler({ data: { agentId: "a" } })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it("RETRIES (rethrows) on a retryable WARMUP_CAP_EXCEEDED", async () => {
    const err = new ComplianceError("WARMUP_CAP_EXCEEDED", {
      retryable: true,
      trpcCode: "TOO_MANY_REQUESTS",
      retryAfterSeconds: 3_600,
    });
    const service = sendService(async () => {
      throw err;
    });
    const handler = makeOutreachSendHandler({ outreachService: service });
    await expect(handler({ data: { agentId: "a" } })).rejects.toBe(err);
  });
});

describe("makeOutreachFollowupHandler", () => {
  it("delegates to sendFollowup", async () => {
    const service = sendService(async () => ({}));
    const handler = makeOutreachFollowupHandler({ outreachService: service });
    await handler({ data: { threadId: "thread-1" } });
    expect(service.sendFollowup).toHaveBeenCalledWith({ threadId: "thread-1" });
  });

  it("drops on a non-retryable error", async () => {
    const service = sendService(async () => {
      throw Object.assign(new Error("opted out"), { retryable: false });
    });
    const handler = makeOutreachFollowupHandler({ outreachService: service });
    await expect(
      handler({ data: { threadId: "t" } }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe("makeWarmupRecalcHandler", () => {
  it("runs the recalc", async () => {
    const recalc = vi.fn().mockResolvedValue({ dailyCap: 40, sentToday: 3 });
    const handler = makeWarmupRecalcHandler({
      warmupService: { recalc } as unknown as WarmupService,
    });
    await handler({ data: {} });
    expect(recalc).toHaveBeenCalledTimes(1);
  });

  it("rethrows a retryable recalc error (unknown → retryable)", async () => {
    const boom = new Error("db blip");
    const handler = makeWarmupRecalcHandler({
      warmupService: {
        recalc: vi.fn().mockRejectedValue(boom),
      } as unknown as WarmupService,
    });
    await expect(handler({ data: {} })).rejects.toBe(boom);
  });
});
