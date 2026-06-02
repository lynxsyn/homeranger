import { afterEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "../index.js";
import { _setOutreachSendEnqueuerForTesting } from "../outreach.router.js";
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

const caller = appRouter.createCaller({ user: { email: "dev@homescout.local" } });

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
  vi.restoreAllMocks();
});

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
