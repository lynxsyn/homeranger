/**
 * M6 outreach + ComplianceGuard E2E (spec test plan, E2E row).
 *
 * Proven end-to-end against real infra (api + pgvector + redis + the BullMQ
 * worker) with the deterministic fake send provider (OUTREACH_FAKE=1 — no real
 * Resend send):
 *   1. A SUPPRESSED corporate agent → outreach.send is BLOCKED by the
 *      ComplianceGuard precheck (tRPC FORBIDDEN, HTTP 403); NO job is enqueued
 *      and NO OutreachMessage row is ever written.
 *   2. A clean corporate agent → outreach.send is ACCEPTED (precheck passes,
 *      the worker sends via the fake provider) and an outbound OutreachMessage
 *      row is persisted (direction=outbound, sentAt set).
 *
 * Auth: the api webServer runs CF_ACCESS_* unset → dev bypass (DEV_USER_EMAIL),
 * so the protectedProcedure mutation is reachable without a login. Cleanup uses
 * a raw pg Client (backend-core is not on the e2e import path).
 */
import { expect, test } from "@playwright/test";
import { Client } from "pg";

const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:3000";
const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://homescout:homescout@localhost:5434/homescout";

const RUN_ID = Date.now().toString(36);
const BLOCKED_EMAIL = `test-outreach-blocked-${RUN_ID}@agency.test`;
const ALLOWED_EMAIL = `test-outreach-allowed-${RUN_ID}@agency.test`;

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

test.beforeAll(async () => {
  await withClient(async (client) => {
    // Two CORPORATE-subscriber agents (so they clear the PECR gate); one is
    // globally suppressed (the hard-block arm).
    // Prisma's @updatedAt has no DB default — a raw INSERT must set it.
    await client.query(
      `INSERT INTO "Agent" (id, email, "agencyName", "mailboxType", "optedOut", "updatedAt")
       VALUES (gen_random_uuid(), $1, 'Blocked Agency', 'corporate_subscriber'::"MailboxType", false, now()),
              (gen_random_uuid(), $2, 'Allowed Agency', 'corporate_subscriber'::"MailboxType", false, now())
       ON CONFLICT (email) DO NOTHING`,
      [BLOCKED_EMAIL, ALLOWED_EMAIL],
    );
    await client.query(
      `INSERT INTO "SuppressionEntry" (id, email, reason, "updatedAt")
       VALUES (gen_random_uuid(), $1, 'spam_complaint'::"SuppressionReason", now())
       ON CONFLICT (email, reason) DO NOTHING`,
      [BLOCKED_EMAIL],
    );
  });
});

test.afterAll(async () => {
  await withClient(async (client) => {
    await client.query(
      `DELETE FROM "OutreachMessage"
         WHERE "threadId" IN (
           SELECT t.id FROM "OutreachThread" t
           JOIN "Agent" a ON a.id = t."agentId"
           WHERE a.email = ANY($1::text[]))`,
      [[BLOCKED_EMAIL, ALLOWED_EMAIL]],
    );
    await client.query(
      `DELETE FROM "OutreachThread"
         WHERE "agentId" IN (SELECT id FROM "Agent" WHERE email = ANY($1::text[]))`,
      [[BLOCKED_EMAIL, ALLOWED_EMAIL]],
    );
    await client.query(`DELETE FROM "Agent" WHERE email = ANY($1::text[])`, [
      [BLOCKED_EMAIL, ALLOWED_EMAIL],
    ]);
    await client.query(`DELETE FROM "SuppressionEntry" WHERE email = $1`, [
      BLOCKED_EMAIL,
    ]);
  });
});

function sendOutreach(
  request: import("@playwright/test").APIRequestContext,
  agentEmail: string,
) {
  // tRPC v11 over HTTP with the superjson transformer wraps inputs as { json }.
  return request.post(`${API_BASE}/trpc/outreach.send`, {
    headers: { "content-type": "application/json" },
    data: { json: { agentEmail } },
    failOnStatusCode: false,
  });
}

function countOutbound(toEmail: string): Promise<number> {
  return withClient(async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "OutreachMessage"
         WHERE "toEmail" = $1 AND direction = 'outbound'`,
      [toEmail],
    );
    return Number(rows[0]?.count ?? "0");
  });
}

test("ComplianceGuard blocks a send to a suppressed agent (403, no OutreachMessage)", async ({
  request,
}) => {
  const res = await sendOutreach(request, BLOCKED_EMAIL);
  expect(res.status()).toBe(403);
  // Give any (incorrectly) enqueued job time to NOT produce a row.
  await new Promise((r) => setTimeout(r, 1_500));
  expect(await countOutbound(BLOCKED_EMAIL)).toBe(0);
});

test("ComplianceGuard allows a clean corporate send → worker persists an outbound OutreachMessage", async ({
  request,
}) => {
  const res = await sendOutreach(request, ALLOWED_EMAIL);
  expect(res.status()).toBe(200);
  await expect
    .poll(() => countOutbound(ALLOWED_EMAIL), { timeout: 20_000 })
    .toBe(1);
});
