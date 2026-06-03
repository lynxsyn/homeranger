import { afterEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "../index.js";
import {
  _setOutreachSendEnqueuerForTesting,
  _setWarmupStateRepositoryForTesting,
} from "../outreach.router.js";
import {
  _setComplianceGuardForTesting,
  ComplianceError,
  type ComplianceGuard,
} from "../../lib/compliance/compliance-guard.js";
import {
  _setAgentRepositoryForTesting,
  AgentRepository,
  type AgentRecord,
} from "../../repositories/agent.repository.js";
import {
  WarmupStateRepository,
  type WarmupStateRecord,
} from "../../repositories/warmup-state.repository.js";

const caller = appRouter.createCaller({
  user: { id: "00000000-0000-0000-0000-0000000000de", email: "dev@homeranger.local" },
});

function agent(): AgentRecord {
  return {
    id: "agent-1",
    email: "branch@agency.test",
    agencyName: "Agency",
    mailboxType: "corporate_subscriber",
    optedOut: false,
    coveredOutcodes: [],
    lastContactedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as AgentRecord;
}

function stubAgent(record: AgentRecord | null): void {
  const repo = new AgentRepository();
  vi.spyOn(repo, "findByEmail").mockResolvedValue(record);
  _setAgentRepositoryForTesting(repo);
}

function stubGuard(impl: () => Promise<void>): void {
  _setComplianceGuardForTesting({ assertCanSend: vi.fn(impl) } as unknown as ComplianceGuard);
}

afterEach(() => {
  _setAgentRepositoryForTesting(null);
  _setComplianceGuardForTesting(null);
  _setOutreachSendEnqueuerForTesting(null);
  _setWarmupStateRepositoryForTesting(null);
  vi.restoreAllMocks();
});

function warmupState(killSwitch: boolean): WarmupStateRecord {
  return {
    id: "warmup-1",
    dailyCap: 20,
    sentToday: 0,
    windowDate: new Date("2026-06-02"),
    killSwitch,
    rampStartedAt: new Date("2026-06-01"),
    createdAt: new Date("2026-06-01"),
    updatedAt: new Date("2026-06-02"),
  } as WarmupStateRecord;
}

describe("outreach.send", () => {
  it("404s when the agent does not exist", async () => {
    stubAgent(null);
    stubGuard(async () => {});
    await expect(
      caller.outreach.send({ agentEmail: "nobody@agency.test" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("maps a ComplianceError block to its trpcCode and does NOT enqueue", async () => {
    stubAgent(agent());
    stubGuard(async () => {
      throw new ComplianceError("SUPPRESSED", {
        retryable: false,
        trpcCode: "FORBIDDEN",
      });
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    _setOutreachSendEnqueuerForTesting(enqueue);

    await expect(
      caller.outreach.send({ agentEmail: "branch@agency.test" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("enqueues outreach:send when the precheck passes", async () => {
    stubAgent(agent());
    stubGuard(async () => {});
    const enqueue = vi.fn().mockResolvedValue(undefined);
    _setOutreachSendEnqueuerForTesting(enqueue);

    const result = await caller.outreach.send({
      agentEmail: "branch@agency.test",
    });
    expect(result).toEqual({ enqueued: true, agentId: "agent-1" });
    expect(enqueue).toHaveBeenCalledWith({
      idempotencyKey: "outreach:send:agent-1",
      payload: { agentId: "agent-1" },
    });
  });
});

describe("outreach.killSwitch", () => {
  it("get reads the current WarmupState.killSwitch", async () => {
    const repo = new WarmupStateRepository();
    const spy = vi
      .spyOn(repo, "getOrCreate")
      .mockResolvedValue(warmupState(true));
    _setWarmupStateRepositoryForTesting(repo);

    const result = await caller.outreach.killSwitch.get();
    expect(result).toEqual({ enabled: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("toggle ON sets the kill-switch and echoes the new state", async () => {
    const repo = new WarmupStateRepository();
    const spy = vi
      .spyOn(repo, "setKillSwitch")
      .mockResolvedValue(warmupState(true));
    _setWarmupStateRepositoryForTesting(repo);

    const result = await caller.outreach.killSwitch.toggle({ enabled: true });
    expect(result).toEqual({ enabled: true });
    expect(spy).toHaveBeenCalledWith(true);
  });

  it("toggle OFF sets the kill-switch back to false", async () => {
    const repo = new WarmupStateRepository();
    const spy = vi
      .spyOn(repo, "setKillSwitch")
      .mockResolvedValue(warmupState(false));
    _setWarmupStateRepositoryForTesting(repo);

    const result = await caller.outreach.killSwitch.toggle({ enabled: false });
    expect(result).toEqual({ enabled: false });
    expect(spy).toHaveBeenCalledWith(false);
  });

  it("rejects an anonymous caller with UNAUTHORIZED", async () => {
    const anon = appRouter.createCaller({ user: null });
    await expect(anon.outreach.killSwitch.get()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
