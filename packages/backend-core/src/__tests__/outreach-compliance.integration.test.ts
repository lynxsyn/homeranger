/**
 * Integration test (M6 test plan, Integration row): an unsubscribe writes a
 * SuppressionEntry(unsubscribe) to real pgvector, and a subsequent
 * ComplianceGuard.assertCanSend — using the REAL suppression repository reading
 * that row back — throws SUPPRESSED. Also asserts the single-point email
 * normalisation (a mixed-case suppression still blocks a lower-case send) so
 * gate 3 can never be split by casing.
 *
 * These gates (PECR → opt-out → suppression) all short-circuit BEFORE the
 * warm-up token bucket (gate 6), so this suite needs Postgres only — no Redis
 * (the api-integration CI job has no redis service). The allowed/cap path is
 * proven by the E2E suite, which does run Redis.
 *
 * Gate: skipped unless VITEST_INTEGRATION=1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  disconnectTestPrisma,
  getTestPrisma,
} from "../test/db-helper.js";
import { suppressionEntryRepository } from "../repositories/suppression-entry.repository.js";
import {
  ComplianceError,
  DefaultComplianceGuard,
  type AgentForGuard,
} from "../lib/compliance/compliance-guard.js";

const db = getTestPrisma();
const TEST_PREFIX = "m6-guard";
const UNSUB_EMAIL = `test-${TEST_PREFIX}-unsub@agency.test`;
const MIXED_CASE_EMAIL = `test-${TEST_PREFIX}-Mixed@Agency.Test`;

const guard = new DefaultComplianceGuard();

function corporate(email: string): AgentForGuard {
  return {
    id: "agent-int-1",
    email,
    mailboxType: "corporate_subscriber",
    optedOut: false,
  };
}

describe.skipIf(process.env.VITEST_INTEGRATION !== "1")(
  "ComplianceGuard: unsubscribe → SuppressionEntry → assertCanSend throws",
  () => {
    beforeAll(async () => {
      await cleanupTestData(db, TEST_PREFIX);
    });

    afterAll(async () => {
      await cleanupTestData(db, TEST_PREFIX);
      await disconnectTestPrisma();
    });

    it("an unsubscribe writes SuppressionEntry(unsubscribe) and then blocks the send (gate 3)", async () => {
      await suppressionEntryRepository.suppress({
        email: UNSUB_EMAIL,
        reason: "unsubscribe",
        note: "one-click unsubscribe",
      });

      const row = await db.suppressionEntry.findUnique({
        where: { email_reason: { email: UNSUB_EMAIL, reason: "unsubscribe" } },
      });
      expect(row).not.toBeNull();

      await expect(
        guard.assertCanSend(corporate(UNSUB_EMAIL)),
      ).rejects.toMatchObject({ code: "SUPPRESSED" });
      await expect(
        guard.assertCanSend(corporate(UNSUB_EMAIL)),
      ).rejects.toBeInstanceOf(ComplianceError);
    });

    it("normalises email at a single point — a mixed-case suppression blocks a lower-case send", async () => {
      await suppressionEntryRepository.suppress({
        email: MIXED_CASE_EMAIL, // stored normalised (lower-cased) by the repo
        reason: "unsubscribe",
      });

      await expect(
        guard.assertCanSend(corporate(MIXED_CASE_EMAIL.toLowerCase())),
      ).rejects.toMatchObject({ code: "SUPPRESSED" });
    });

    it("blocks an opted-out agent before reaching suppression (gate 2)", async () => {
      await expect(
        guard.assertCanSend({
          ...corporate(`test-${TEST_PREFIX}-clean@agency.test`),
          optedOut: true,
        }),
      ).rejects.toMatchObject({ code: "OPTED_OUT" });
    });
  },
);
