/**
 * Integration test (M7 test plan): AgentDiscoveryService upserts discovered
 * agents into real pgvector with the region's outcodes + classified mailbox
 * type, skips suppressed emails, and is idempotent on re-run. Uses the REAL
 * agent + suppression repositories with an injected deterministic provider (no
 * network). Gate: skipped unless VITEST_INTEGRATION=1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  disconnectTestPrisma,
  getTestPrisma,
} from "../test/db-helper.js";
import { DefaultAgentDiscoveryService } from "../services/agent-discovery.service.js";
import { suppressionEntryRepository } from "../repositories/suppression-entry.repository.js";
import type {
  AgentDiscoveryProvider,
  DiscoveredAgent,
} from "../lib/discovery/agent-discovery.provider.js";

const db = getTestPrisma();
const TEST_PREFIX = "m7-disc";
const CORP_EMAIL = `test-${TEST_PREFIX}-corp@conwyagents.test`;
const FREE_EMAIL = `test-${TEST_PREFIX}-free@gmail.com`;
const SUPPRESSED_EMAIL = `test-${TEST_PREFIX}-supp@agency.test`;

function fakeProvider(agents: DiscoveredAgent[]): AgentDiscoveryProvider {
  return { async discover() { return agents; } };
}

describe.skipIf(process.env.VITEST_INTEGRATION !== "1")(
  "AgentDiscoveryService: discover → classify → upsert (real pgvector)",
  () => {
    const service = new DefaultAgentDiscoveryService({
      provider: fakeProvider([
        { email: CORP_EMAIL, agencyName: "Conwy Agents Ltd" },
        { email: FREE_EMAIL, agencyName: "Sole Trader" },
        { email: SUPPRESSED_EMAIL, agencyName: "Already Suppressed" },
      ]),
    });

    beforeAll(async () => {
      await cleanupTestData(db, TEST_PREFIX);
      await suppressionEntryRepository.suppress({
        email: SUPPRESSED_EMAIL,
        reason: "unsubscribe",
      });
    });

    afterAll(async () => {
      await cleanupTestData(db, TEST_PREFIX);
      await disconnectTestPrisma();
    });

    it("upserts agents with region outcodes + classified mailbox type, skipping suppressed", async () => {
      const result = await service.discoverRegion("Conwy County");
      expect(result).toEqual({ discovered: 3, upserted: 2, skipped: 1 });

      const corp = await db.agent.findUnique({ where: { email: CORP_EMAIL } });
      expect(corp?.mailboxType).toBe("corporate_subscriber");
      expect(corp?.coveredOutcodes).toContain("LL32");

      const free = await db.agent.findUnique({ where: { email: FREE_EMAIL } });
      expect(free?.mailboxType).toBe("individual");

      const supp = await db.agent.findUnique({
        where: { email: SUPPRESSED_EMAIL },
      });
      expect(supp).toBeNull(); // skipped — never sourced
    });

    it("is idempotent — a re-run does not duplicate agents", async () => {
      const result = await service.discoverRegion("Conwy County");
      expect(result).toEqual({ discovered: 3, upserted: 2, skipped: 1 });
      const count = await db.agent.count({
        where: { email: { in: [CORP_EMAIL, FREE_EMAIL] } },
      });
      expect(count).toBe(2);
    });
  },
);
