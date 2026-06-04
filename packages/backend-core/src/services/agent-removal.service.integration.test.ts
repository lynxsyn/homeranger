/**
 * Integration test for eraseAgentById against a real pgvector Postgres — proves
 * the GDPR-COMPLETE erasure end to end: the Agent row, its OutreachThreads (FK
 * ON DELETE CASCADE), AND its EmailEvent delivery feed (keyed by email, NO FK —
 * purged explicitly in the same transaction) are all gone afterward.
 *
 * Gate: integration project only (VITEST_INTEGRATION=1 + DATABASE_URL).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  disconnectTestPrisma,
  getTestPrisma,
} from "../test/db-helper.js";
import { eraseAgentById } from "./agent-removal.service.js";

const db = getTestPrisma();
const EMAIL = "erase-agent-fixture@agency.test";

async function seed(): Promise<string> {
  const agent = await db.agent.create({
    data: {
      email: EMAIL,
      agencyName: "Erase Co",
      mailboxType: "corporate_subscriber",
      coveredOutcodes: ["ZE9"],
    },
    select: { id: true },
  });
  // A thread proves the FK cascade; an EmailEvent (no FK to Agent) proves the
  // explicit purge — both carry the agent's data and must be erased.
  await db.outreachThread.create({ data: { agentId: agent.id, subject: "Hello" } });
  await db.emailEvent.create({
    data: {
      providerEventId: `erase-evt-${agent.id}`,
      email: EMAIL,
      eventType: "delivered",
    },
  });
  return agent.id;
}

async function cleanup(): Promise<void> {
  await db.emailEvent.deleteMany({ where: { email: EMAIL } });
  await db.agent.deleteMany({ where: { email: EMAIL } });
}

beforeEach(cleanup);
afterEach(async () => {
  await cleanup();
  await cleanupTestData(db);
});
afterAll(async () => {
  await disconnectTestPrisma();
});

describe("eraseAgentById (real pgvector) — GDPR complete erasure", () => {
  it("erases the agent, its threads (FK cascade), AND its EmailEvent feed", async () => {
    const agentId = await seed();
    expect(await db.agent.count({ where: { id: agentId } })).toBe(1);
    expect(await db.outreachThread.count({ where: { agentId } })).toBe(1);
    expect(await db.emailEvent.count({ where: { email: EMAIL } })).toBe(1);

    const result = await eraseAgentById(agentId);
    expect(result).toEqual({ id: agentId });

    expect(await db.agent.count({ where: { id: agentId } })).toBe(0);
    expect(await db.outreachThread.count({ where: { agentId } })).toBe(0);
    expect(await db.emailEvent.count({ where: { email: EMAIL } })).toBe(0);
  });

  it("throws Prisma P2025 for a missing agent", async () => {
    await expect(
      eraseAgentById("00000000-0000-7000-8000-0000000000ff"),
    ).rejects.toMatchObject({ code: "P2025" });
  });
});
