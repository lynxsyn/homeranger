import { describe, expect, it, vi } from "vitest";
import { DefaultWarmupService, type WarmupConfig } from "./warmup.service.js";
import type { WarmupStateRepository } from "../repositories/warmup-state.repository.js";
import type { OutreachRepository } from "../repositories/outreach.repository.js";

const CONFIG: WarmupConfig = { baseCap: 20, step: 20, maxCap: 200 };
const NOW = new Date("2026-06-10T00:00:00Z");

function makeHarness(opts: {
  rampStartedAt: Date;
  dailyCap?: number;
  sends?: number;
}) {
  const getOrCreate = vi.fn().mockResolvedValue({
    id: "w1",
    dailyCap: opts.dailyCap ?? 20,
    sentToday: 0,
    windowDate: NOW,
    killSwitch: false,
    rampStartedAt: opts.rampStartedAt,
    createdAt: opts.rampStartedAt,
    updatedAt: opts.rampStartedAt,
  });
  const setDailyCap = vi.fn().mockResolvedValue(undefined);
  const reconcileWindow = vi.fn().mockResolvedValue(undefined);
  const countOutboundSince = vi.fn().mockResolvedValue(opts.sends ?? 0);

  const service = new DefaultWarmupService({
    warmupStateRepository: {
      getOrCreate,
      setDailyCap,
      reconcileWindow,
    } as unknown as WarmupStateRepository,
    outreachRepository: {
      countOutboundSince,
    } as unknown as OutreachRepository,
    config: CONFIG,
    now: () => NOW,
  });
  return { service, setDailyCap, reconcileWindow, countOutboundSince };
}

describe("WarmupService.recalc", () => {
  it("day 0: cap stays at base, no setDailyCap, reconciles sentToday", async () => {
    const h = makeHarness({ rampStartedAt: NOW, dailyCap: 20, sends: 5 });
    const result = await h.service.recalc();
    expect(result).toEqual({ dailyCap: 20, sentToday: 5 });
    expect(h.setDailyCap).not.toHaveBeenCalled();
    expect(h.reconcileWindow).toHaveBeenCalledWith({
      windowDate: NOW,
      sentToday: 5,
    });
  });

  it("ramps the cap by step per full day since ramp start", async () => {
    const threeDaysAgo = new Date("2026-06-07T00:00:00Z");
    const h = makeHarness({ rampStartedAt: threeDaysAgo, dailyCap: 20 });
    const result = await h.service.recalc();
    expect(result.dailyCap).toBe(80); // 20 + 3*20
    expect(h.setDailyCap).toHaveBeenCalledWith(80);
  });

  it("clamps the cap at maxCap", async () => {
    const longAgo = new Date("2026-01-01T00:00:00Z");
    const h = makeHarness({ rampStartedAt: longAgo, dailyCap: 20 });
    const result = await h.service.recalc();
    expect(result.dailyCap).toBe(200);
  });
});
