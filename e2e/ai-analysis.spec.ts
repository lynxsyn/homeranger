/**
 * M5 AI-analysis E2E (spec test plan, E2E row).
 *
 * Flow proven end-to-end against real infra (api + BullMQ worker + pgvector +
 * redis) with the DETERMINISTIC fake providers (ANALYSIS_FAKE=1 — no Anthropic /
 * Voyage / R2 calls):
 *   1. POST a Svix-signed simulated Resend `email.received` → 202.
 *   2. The worker ingests it (creating a pre-market Listing) and auto-enqueues
 *      analyze:listing; the analysis handler scores a synthetic photo, embeds
 *      the listing, and re-matches it against the seeded SearchProfile —
 *      writing PhotoAnalysis + Listing.embedding + ListingScore.
 *   3. /listings renders the row; its match-score RING shows the blended 0–100
 *      score once analysis lands (the HomeRanger design surfaces the score as a
 *      per-row ring — there is no row-expand panel; the `listings.expand`
 *      endpoint remains for a future detail view).
 *   4. Because the analysed listing is the only SCORED row, the default
 *      match-score sort places it FIRST (scored before the unscored seed
 *      fixtures — nulls sink), proving the table sorts by match score.
 *
 * The Svix secret MUST equal E2E_RESEND_INBOUND_SECRET in playwright.config.ts.
 */
import crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import { Client } from "pg";

const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:3000";

const SECRET =
  process.env.RESEND_INBOUND_WEBHOOK_SECRET ??
  "whsec_aG9tZXNjb3V0LWUyZS1pbmJvdW5kLXNlY3JldA==";

// Digit-free run id: map base36 digits → letters so the prefix can NEVER form a
// postcode-like token the fake extractor might grab instead of the real
// postcode (which previously mangled the stored address + leaked the row).
const RUN_ID = Date.now()
  .toString(36)
  .replace(/[0-9]/g, (d) => String.fromCharCode(103 + Number(d)));
const STREET = `${RUN_ID} Analysis Test Road`;
const POSTCODE = "EC1A 1BB";
const EMAIL_ID = `e2e-analysis-${RUN_ID}`;
const EXPECTED_ADDRESS_NORMALIZED = `${STREET} ${POSTCODE}`.toUpperCase();

function signSvix(body: string, id: string, ts: string): string {
  const stripped = SECRET.startsWith("whsec_") ? SECRET.slice(6) : SECRET;
  const key = Buffer.from(stripped, "base64");
  const signedContent = `${id}.${ts}.${body}`;
  return `v1,${crypto.createHmac("sha256", key).update(signedContent).digest("base64")}`;
}

const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://homeranger:homeranger@localhost:5434/homeranger";

// Remove the listing this spec creates (cascade drops its PhotoAnalysis +
// ListingScore) so it does not pollute the M3 listings-table specs' exact row
// count, mirroring the M4 inbound spec's cleanup.
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

test("ingest → analyze → the row's score ring shows the match score", async ({
  page,
  request,
}) => {
  const body = JSON.stringify({
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: EMAIL_ID,
      from: "agent@example.com",
      to: ["inbox@homeranger.app"],
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

  const rowSelector = `[data-testid="listing-row"][data-address="${EXPECTED_ADDRESS_NORMALIZED}"]`;

  // Poll: reload until the row appears (ingested) AND its match-score ring shows
  // a real number. The ring reads "–" while the listing is unscored; once
  // analyze:listing writes a ListingScore, list() attaches combinedScore and the
  // ring renders the blended 0–100 score. (Deterministic fake vectors are
  // near-orthogonal, so a low score can legitimately round to 0 — 0 is valid.)
  await expect(async () => {
    await page.goto("/listings");
    await expect(page.getByTestId("listings-table")).toBeVisible();

    const row = page.locator(rowSelector);
    await expect(row).toHaveCount(1, { timeout: 2000 });
    await expect(row.getByTestId("match-score")).toHaveText(
      /^(0|[1-9][0-9]?|100)$/,
      { timeout: 2000 },
    );
  }).toPass({ timeout: 45_000 });
});

test("the analysed (scored) listing sorts first by match score", async ({
  page,
}) => {
  // Default sort is match-score DESC, nulls last: the only scored row (the one
  // this suite analysed) must lead the unscored seed fixtures. Reload each poll
  // so the query refetches (react-query staleTime would otherwise serve cache).
  await expect(async () => {
    await page.goto("/listings");
    await expect(page.getByTestId("listings-table")).toBeVisible();
    await expect(page.getByTestId("listing-row").first()).toHaveAttribute(
      "data-address",
      EXPECTED_ADDRESS_NORMALIZED,
    );
  }).toPass({ timeout: 45_000 });
});

test("the search link-through surfaces the analysed listing's PER-SEARCH score", async ({
  page,
}) => {
  // The seeded operator search "Bright modern flats" covers EC1A (the ingest
  // outcode), so analyze:listing scored the listing against THAT search. Reaching
  // /listings via its "View homes found" link-through passes the search id as the
  // scoring lens, and the row's ring must show that search's score (proving the
  // per-search lens end-to-end, not just the unfiltered MAX path above).
  await expect(async () => {
    await page.goto("/searches");
    const card = page.locator(
      '[data-testid="search-card"][data-search-name="Bright modern flats"]',
    );
    await expect(card).toHaveCount(1, { timeout: 2000 });
    await card.getByTestId("search-homes-link").click();

    // Scoped to the search (the link-through banner is shown).
    await expect(page.getByTestId("search-filter-banner")).toBeVisible({
      timeout: 2000,
    });

    // The analysed EC1A listing is in the patch and shows its per-search ring.
    const row = page.locator(
      `[data-testid="listing-row"][data-address="${EXPECTED_ADDRESS_NORMALIZED}"]`,
    );
    await expect(row).toHaveCount(1, { timeout: 2000 });
    await expect(row.getByTestId("match-score")).toHaveText(
      /^(0|[1-9][0-9]?|100)$/,
      { timeout: 2000 },
    );
  }).toPass({ timeout: 45_000 });
});
