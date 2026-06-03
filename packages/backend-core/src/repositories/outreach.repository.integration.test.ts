/**
 * Integration tests for outreachRepository.latestStatusByAgentIds (PR1, the
 * Agents-screen status join) exercised against real Postgres. Proves the method
 * picks each agent's MOST-RECENT non-`closed` thread, ignores `closed`
 * (opted-out) threads, and omits agents with no open thread. This is the
 * behaviour the agentsRouter status mapping depends on.
 *
 * Gate: skipped unless VITEST_INTEGRATION=1 (mirrors the sibling
 * *.integration.test.ts files).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OutreachThreadStatus } from "@prisma/client";
import {
  cleanupTestData,
  disconnectTestPrisma,
  getTestPrisma,
} from "../test/db-helper.js";
import { agentRepository } from "./agent.repository.js";
import { outreachRepository } from "./outreach.repository.js";

const db = getTestPrisma();

beforeEach(async () => {
  await cleanupTestData(db);
});
afterEach(async () => {
  await cleanupTestData(db);
});
afterAll(async () => {
  await disconnectTestPrisma();
});

/** Create a thread for `agentId` with an explicit status + activity time. */
async function makeThread(
  agentId: string,
  status: OutreachThreadStatus,
  lastMessageAt: Date | null,
): Promise<void> {
  await db.outreachThread.create({
    data: { agentId, subject: "test", status, lastMessageAt },
  });
}

describe.skipIf(process.env.VITEST_INTEGRATION !== "1")(
  "outreachRepository.latestStatusByAgentIds",
  () => {
    it("returns the MOST-RECENT non-closed thread status per agent", async () => {
      const agent = await agentRepository.upsertByEmail({
        email: "test-pr1-latest@example.com",
        agencyName: "Latest Agency",
      });
      // An older awaiting_reply thread + a newer replied thread → replied wins.
      await makeThread(
        agent.id,
        "awaiting_reply",
        new Date("2026-05-01T00:00:00.000Z"),
      );
      await makeThread(
        agent.id,
        "replied",
        new Date("2026-05-10T00:00:00.000Z"),
      );

      const statuses = await outreachRepository.latestStatusByAgentIds([
        agent.id,
      ]);
      expect(statuses.get(agent.id)).toBe("replied");
    });

    it("ignores closed threads (an opted-out conversation never sets the status)", async () => {
      const agent = await agentRepository.upsertByEmail({
        email: "test-pr1-closed@example.com",
        agencyName: "Closed Agency",
      });
      await makeThread(
        agent.id,
        "closed",
        new Date("2026-05-20T00:00:00.000Z"),
      );

      const statuses = await outreachRepository.latestStatusByAgentIds([
        agent.id,
      ]);
      // Only a closed thread → the agent is ABSENT (router treats absence as queued).
      expect(statuses.has(agent.id)).toBe(false);
    });

    it("omits agents with no thread at all and isolates per agent", async () => {
      const withThread = await agentRepository.upsertByEmail({
        email: "test-pr1-with@example.com",
        agencyName: "With Thread",
      });
      const without = await agentRepository.upsertByEmail({
        email: "test-pr1-without@example.com",
        agencyName: "No Thread",
      });
      await makeThread(
        withThread.id,
        "active",
        new Date("2026-05-15T00:00:00.000Z"),
      );

      const statuses = await outreachRepository.latestStatusByAgentIds([
        withThread.id,
        without.id,
      ]);
      expect(statuses.get(withThread.id)).toBe("active");
      expect(statuses.has(without.id)).toBe(false);
      expect(statuses.size).toBe(1);
    });

    it("falls back to createdAt order when lastMessageAt is still NULL", async () => {
      const agent = await agentRepository.upsertByEmail({
        email: "test-pr1-nullts@example.com",
        agencyName: "Null Timestamp",
      });
      // Both threads have a NULL lastMessageAt (never sent); the tiebreak orders
      // by createdAt desc, so the second (later-created) `awaiting_reply` wins.
      await makeThread(agent.id, "active", null);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await makeThread(agent.id, "awaiting_reply", null);

      const statuses = await outreachRepository.latestStatusByAgentIds([
        agent.id,
      ]);
      expect(statuses.get(agent.id)).toBe("awaiting_reply");
    });

    it("returns an empty Map for an empty id list (no query)", async () => {
      const statuses = await outreachRepository.latestStatusByAgentIds([]);
      expect(statuses.size).toBe(0);
    });
  },
);
