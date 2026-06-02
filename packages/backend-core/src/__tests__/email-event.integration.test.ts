/**
 * Integration test for the events path (M4 test plan, Integration row): a
 * hard-bounce event → EmailEvent row + SuppressionEntry(hard_bounce), against
 * docker pgvector via the real email-event + suppression repositories. Also
 * asserts idempotency (a redelivered providerEventId is a no-op) and that a soft
 * (Transient) bounce records an EmailEvent but does NOT suppress.
 *
 * Gate: skipped unless VITEST_INTEGRATION=1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  disconnectTestPrisma,
  getTestPrisma,
} from "../test/db-helper.js";
import { DefaultEmailEventService } from "../services/email-event.service.js";

const db = getTestPrisma();
const TEST_PREFIX = "m4-event";
const HARD_EMAIL = `test-${TEST_PREFIX}-hardbounce@example.com`;
const SOFT_EMAIL = `test-${TEST_PREFIX}-softbounce@example.com`;

const service = new DefaultEmailEventService();

describe.skipIf(process.env.VITEST_INTEGRATION !== "1")(
  "email-event: bounce → EmailEvent + SuppressionEntry",
  () => {
    beforeAll(async () => {
      await cleanupTestData(db, TEST_PREFIX);
    });

    afterAll(async () => {
      await cleanupTestData(db, TEST_PREFIX);
      await disconnectTestPrisma();
    });

    it("a Permanent bounce writes an EmailEvent and a hard_bounce SuppressionEntry", async () => {
      const result = await service.ingestEvent({
        providerEventId: `test-${TEST_PREFIX}-evt-hard-1`,
        type: "email.bounced",
        data: {
          email_id: "email-hard-1",
          to: [HARD_EMAIL],
          bounce: { type: "Permanent", message: "address does not exist" },
        },
      });

      expect(result.created).toBe(true);
      expect(result.suppressed).toBe(true);

      const event = await db.emailEvent.findUnique({
        where: { providerEventId: `test-${TEST_PREFIX}-evt-hard-1` },
      });
      expect(event).not.toBeNull();
      expect(event!.eventType).toBe("bounced");
      expect(event!.email).toBe(HARD_EMAIL);

      const suppression = await db.suppressionEntry.findUnique({
        where: {
          email_reason: { email: HARD_EMAIL, reason: "hard_bounce" },
        },
      });
      expect(suppression).not.toBeNull();
    });

    it("a redelivered hard bounce is idempotent (no second suppression mutation)", async () => {
      const result = await service.ingestEvent({
        providerEventId: `test-${TEST_PREFIX}-evt-hard-1`,
        type: "email.bounced",
        data: {
          email_id: "email-hard-1",
          to: [HARD_EMAIL],
          bounce: { type: "Permanent" },
        },
      });
      expect(result.created).toBe(false);
      expect(result.suppressed).toBe(false);

      const eventCount = await db.emailEvent.count({
        where: { providerEventId: `test-${TEST_PREFIX}-evt-hard-1` },
      });
      const supCount = await db.suppressionEntry.count({
        where: { email: HARD_EMAIL, reason: "hard_bounce" },
      });
      expect(eventCount).toBe(1);
      expect(supCount).toBe(1);
    });

    it("a Transient (soft) bounce records the event but does NOT suppress", async () => {
      const result = await service.ingestEvent({
        providerEventId: `test-${TEST_PREFIX}-evt-soft-1`,
        type: "email.bounced",
        data: {
          email_id: "email-soft-1",
          to: [SOFT_EMAIL],
          bounce: { type: "Transient", message: "mailbox full" },
        },
      });

      expect(result.created).toBe(true);
      expect(result.suppressed).toBe(false);

      const event = await db.emailEvent.findUnique({
        where: { providerEventId: `test-${TEST_PREFIX}-evt-soft-1` },
      });
      expect(event).not.toBeNull();

      const suppression = await db.suppressionEntry.findFirst({
        where: { email: SOFT_EMAIL },
      });
      expect(suppression).toBeNull();
    });
  },
);
