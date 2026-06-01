/**
 * Integration test for agentRepository.list cursor pagination. Proves the
 * uuid(7) id keyset paginates with NO skip and NO overlap even when many agents
 * are created within the same millisecond (the case the previous ms-truncated
 * timestamp cursor could duplicate at a page boundary). M2 review fix.
 *
 * Gate: integration project only (VITEST_INTEGRATION=1 + DATABASE_URL).
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  cleanupTestData,
  disconnectTestPrisma,
  getTestPrisma,
} from "../test/db-helper.js";
import { agentRepository } from "./agent.repository.js";

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

describe("agentRepository.list cursor pagination (uuid7 id keyset)", () => {
  it("paginates all agents with no skip and no overlap (same-millisecond creation)", async () => {
    const total = 7;
    // Tight loop so several rows share a createdAt millisecond. `test-` prefix
    // so cleanupTestData removes them.
    for (let i = 0; i < total; i += 1) {
      await agentRepository.upsertByEmail({
        email: `test-m2-agent-pg-${i}@example.com`,
        agencyName: `Agency ${i}`,
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await agentRepository.list({ limit: 2, cursor });
      seen.push(...page.items.map((a) => a.id));
      if (!page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
    }

    expect(seen).toHaveLength(total); // no skip
    expect(new Set(seen).size).toBe(total); // no overlap / no duplicate
  });
});
