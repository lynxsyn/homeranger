/**
 * Unit tests for agent-removal.service — the GDPR-complete agent erasure. No DB:
 * the agent + email-event repository singletons are swapped for spies, and the
 * transaction boundary is a stub runner that invokes the callback with a dummy
 * tx. Asserts the agent + its EmailEvent feed are erased in one transaction, and
 * the NOT_FOUND (P2025) contract for a missing agent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  eraseAgentById,
  _setAgentRemovalTransactionRunnerForTesting,
} from "./agent-removal.service.js";
import {
  AgentRepository,
  _setAgentRepositoryForTesting,
  type AgentRecord,
} from "../repositories/agent.repository.js";
import {
  EmailEventRepository,
  _setEmailEventRepositoryForTesting,
} from "../repositories/email-event.repository.js";

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "00000000-0000-7000-8000-0000000000a1",
    email: "info@agency.test",
    agencyName: "Agency",
    mailboxType: "corporate_subscriber",
    optedOut: false,
    coveredOutcodes: ["SE1"],
    lastContactedAt: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as AgentRecord;
}

function inject(agent: AgentRecord | null) {
  const agentRepo = new AgentRepository();
  const getById = vi.spyOn(agentRepo, "getById").mockResolvedValue(agent);
  const deleteById = vi.spyOn(agentRepo, "deleteById").mockResolvedValue(undefined);
  _setAgentRepositoryForTesting(agentRepo);

  const eventRepo = new EmailEventRepository();
  const deleteByEmails = vi
    .spyOn(eventRepo, "deleteByEmails")
    .mockResolvedValue(0);
  _setEmailEventRepositoryForTesting(eventRepo);

  _setAgentRemovalTransactionRunnerForTesting(async (fn) =>
    fn({} as never),
  );
  return { getById, deleteById, deleteByEmails };
}

afterEach(() => {
  _setAgentRepositoryForTesting(null);
  _setEmailEventRepositoryForTesting(null);
  _setAgentRemovalTransactionRunnerForTesting(null);
  vi.restoreAllMocks();
});

describe("eraseAgentById", () => {
  it("erases the agent + its EmailEvent feed atomically and echoes { id }", async () => {
    const spies = inject(makeAgent());

    const result = await eraseAgentById("00000000-0000-7000-8000-0000000000a1");

    expect(result).toEqual({ id: "00000000-0000-7000-8000-0000000000a1" });
    expect(spies.deleteById).toHaveBeenCalledWith(
      "00000000-0000-7000-8000-0000000000a1",
      expect.anything(),
    );
    // The EmailEvent feed (keyed by email, no FK → would otherwise survive) is
    // purged in the SAME transaction, by the agent's address.
    expect(spies.deleteByEmails).toHaveBeenCalledWith(
      ["info@agency.test"],
      expect.anything(),
    );
  });

  it("throws Prisma P2025 (→ NOT_FOUND) for a missing agent, mutating nothing", async () => {
    const spies = inject(null);

    await expect(eraseAgentById("ghost")).rejects.toMatchObject({ code: "P2025" });
    expect(spies.deleteById).not.toHaveBeenCalled();
    expect(spies.deleteByEmails).not.toHaveBeenCalled();
  });
});
