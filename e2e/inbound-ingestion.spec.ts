/**
 * M4 inbound-ingestion E2E (spec test plan, E2E row).
 *
 * Flow proven end-to-end against real infra (api + BullMQ worker + pgvector +
 * redis):
 *   1. POST a Svix-signed simulated Resend `email.received` to
 *      /webhooks/resend/inbound on the api (:3000), using the SAME test
 *      `whsec_` secret the api verifies against → expect 202.
 *   2. The api enqueues outreach:inbound; the worker (RESEND_FAKE=1 +
 *      EXTRACTION_FAKE=1) hydrates from the metadata, the fake extractor parses
 *      the address + price from the subject, dedup + upsert run, and a Listing
 *      with isPreMarket=true is created.
 *   3. Navigate to /listings (which renders listingsRouter.list) and assert the
 *      new pre-market row appears.
 *
 * The Svix secret here MUST equal E2E_RESEND_INBOUND_SECRET in
 * playwright.config.ts (both default to this value).
 */
import crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import { Client } from "pg";

const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:3000";

// Must match playwright.config.ts E2E_RESEND_INBOUND_SECRET.
const SECRET =
  process.env.RESEND_INBOUND_WEBHOOK_SECRET ??
  "whsec_aG9tZXNjb3V0LWUyZS1pbmJvdW5kLXNlY3JldA==";

// A unique address per run so re-runs (reuseExistingServer) don't collide on the
// dedup key. The fake extractor parses "<address> <postcode>" out of the subject.
// Digit-free run id: map base36 digits → letters so the prefix can NEVER form a
// postcode-like token the fake extractor might grab instead of the real
// postcode (which previously mangled the stored address + leaked the row).
const RUN_ID = Date.now()
  .toString(36)
  .replace(/[0-9]/g, (d) => String.fromCharCode(103 + Number(d)));
const STREET = `${RUN_ID} Inbound Test Road`;
const POSTCODE = "EC1A 1BB";
const EMAIL_ID = `e2e-inbound-${RUN_ID}`;
// The dedup key builder upper-cases the address; the M3 table renders the RAW
// addressNormalized in the data-address attribute (ListingsPage.tsx:240). So the
// expected attribute value is the UPPER-CASED "<street> <postcode>".
const EXPECTED_ADDRESS_NORMALIZED = `${STREET} ${POSTCODE}`.toUpperCase();

function signSvix(body: string, id: string, ts: string): string {
  const stripped = SECRET.startsWith("whsec_") ? SECRET.slice(6) : SECRET;
  const key = Buffer.from(stripped, "base64");
  const signedContent = `${id}.${ts}.${body}`;
  return `v1,${crypto.createHmac("sha256", key).update(signedContent).digest("base64")}`;
}

const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://homescout:homescout@localhost:5434/homescout";

// Clean up the listing + source record this spec creates so it does NOT pollute
// the M3 listings-table specs (which assert an exact seeded row count) running
// in the same shared pgvector DB. Uses a raw pg client (resolvable from e2e/'s
// hoisted node_modules — backend-core is not on the e2e import path).
test.afterAll(async () => {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    // Delete the listing this run created — by its source record's externalId
    // (reliable even if the extractor stored a slightly different address) OR the
    // expected address; the FK cascade removes its ListingSourceRecord.
    await client.query(
      `DELETE FROM "Listing" WHERE "id" IN (SELECT "listingId" FROM "ListingSourceRecord" WHERE "externalId" = $1) OR "addressNormalized" = $2`,
      [EMAIL_ID, EXPECTED_ADDRESS_NORMALIZED],
    );
  } finally {
    await client.end();
  }
});

test("a signed Resend email.received POST becomes a pre-market Listing", async ({
  page,
  request,
}) => {
  const body = JSON.stringify({
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: EMAIL_ID,
      from: "agent@example.com",
      to: ["inbox@homescout.app"],
      subject: `New listing: ${STREET} ${POSTCODE}, £450,000`,
      attachments: [],
    },
  });
  const id = `msg_${RUN_ID}`;
  const ts = String(Math.floor(Date.now() / 1000));

  const res = await request.post(`${API_BASE}/webhooks/resend/inbound`, {
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": signSvix(body, id, ts),
    },
    data: body,
  });
  expect(res.status()).toBe(202);

  // The worker consumes asynchronously — poll the listings page until the new
  // pre-market row renders. listingsRouter.list backs the table.
  await expect(async () => {
    await page.goto("/listings");
    await expect(page.getByTestId("listings-table")).toBeVisible();
    const row = page.locator(
      `[data-testid="listing-row"][data-address="${EXPECTED_ADDRESS_NORMALIZED}"]`,
    );
    await expect(row).toHaveCount(1, { timeout: 2000 });
  }).toPass({ timeout: 30_000 });
});
