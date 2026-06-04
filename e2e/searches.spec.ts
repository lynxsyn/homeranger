/**
 * Searches E2E (M8 PR1) — the golden path for the new /searches route + the
 * search→listings link-through, against real infra (api + pgvector via the
 * Playwright webServer, dev-bypass auth).
 *
 * Covers:
 *   1. /searches renders; "New search" opens the editor;
 *   2. filling the brief updates the LIVE outreach email preview;
 *   3. Create persists (the search card appears);
 *   4. the status pill opens the relationship-safe pause-confirm, and
 *      confirming flips the search to Paused;
 *   5. "View homes found" navigates to /listings filtered by the search's
 *      resolved outcodes, shows the search-filter banner (name + outcodes +
 *      Paused status), and "All listings" clears it.
 *
 * The search is created through the UI (proving create end-to-end) under a
 * unique, prefixed name; afterAll deletes every `E2E Search%` row so the run is
 * idempotent and does not pollute other specs.
 */
import { expect, test } from "@playwright/test";
import { Client } from "pg";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://homeranger:homeranger@localhost:5434/homeranger";

const RUN_ID = Date.now().toString(36);
const SEARCH_NAME = `E2E Search ${RUN_ID}`;
// The cascade test creates its search over a DEDICATED synthetic outcode (ZZ9,
// honoured verbatim by resolveSearchOutcodes) and seeds ONE listing + ONE agent
// into exactly that patch, so removalPreview reports listingsToHide=1 +
// agentsToRemove=1 and the cascade can never touch the SE1/M3 seeded fixtures or
// the demo agents the other specs assert on.
const CASCADE_OUTCODE = "ZZ9";
const CASCADE_SEARCH_NAME = `E2E Search Cascade ${RUN_ID}`;
const CASCADE_ADDRESS = `cascade home ${RUN_ID} zz9`;
const CASCADE_AGENT_EMAIL = `e2e-cascade-${RUN_ID}@agency.test`;

// The editor is a tall form; give it a desktop-height viewport so its scrollable
// body comfortably shows the outreach-preview toggle (the default 720px clips it).
test.use({ viewport: { width: 1280, height: 1000 } });

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Seed ONE listing + ONE agent into the dedicated ZZ9 patch (raw INSERTs —
 * @updatedAt has no DB default). Idempotent on the unique keys (address / email)
 * so a reused local server is re-run safe. The cascade's outcode match upper-cases
 * resolved outcodes, so the listing's `outcode` is stored upper-case.
 */
async function seedCascadePatch(): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO "Listing"
         (id, "addressNormalized", postcode, outcode, "pricePence", bedrooms,
          "listingStatus", "isPreMarket", "primarySource", "updatedAt")
       VALUES (gen_random_uuid(), $1, 'ZZ9 9ZZ', $2, 39900000, 2,
               'live'::"ListingStatus", false, 'agent_email'::"ListingSource", now())
       ON CONFLICT ("addressNormalized") DO UPDATE SET outcode = EXCLUDED.outcode`,
      [CASCADE_ADDRESS, CASCADE_OUTCODE],
    );
    await client.query(
      `INSERT INTO "Agent"
         (id, email, "agencyName", "mailboxType", "optedOut", "coveredOutcodes",
          "updatedAt")
       VALUES (gen_random_uuid(), $1, 'E2E Cascade Agency',
               'corporate_subscriber'::"MailboxType", false, ARRAY[$2]::text[], now())
       ON CONFLICT (email) DO UPDATE SET "coveredOutcodes" = EXCLUDED."coveredOutcodes"`,
      [CASCADE_AGENT_EMAIL, CASCADE_OUTCODE],
    );
  });
}

/** Remove every artefact the cascade test created for the ZZ9 patch. */
async function cleanupCascadePatch(): Promise<void> {
  await withClient(async (client) => {
    // DismissedListing cascades on the Listing delete (onDelete: Cascade), so the
    // operator's "hidden" overlay row goes with the listing.
    await client.query(`DELETE FROM "Listing" WHERE "addressNormalized" = $1`, [
      CASCADE_ADDRESS,
    ]);
    // Agent threads/messages cascade on the Agent delete; this also covers an
    // agent the cascade did NOT remove (test failed mid-flight).
    await client.query(`DELETE FROM "Agent" WHERE email = $1`, [
      CASCADE_AGENT_EMAIL,
    ]);
  });
}

test.beforeAll(seedCascadePatch);

test.afterAll(async () => {
  await withClient(async (client) => {
    await client.query(`DELETE FROM "Search" WHERE "name" LIKE 'E2E Search%'`);
  });
  await cleanupCascadePatch();
});

test("search golden path: create → live email preview → pause-confirm → link-through", async ({
  page,
}) => {
  await page.goto("/searches");
  await expect(page.getByRole("heading", { name: "Searches" })).toBeVisible();

  // 1. Open the editor.
  await page.getByTestId("new-search").click();
  const editor = page.getByTestId("search-editor");
  await expect(editor).toBeVisible();

  // 2. Fill the brief — a location whose outcodes (SE1, SE16) match seeded homes.
  await page.getByTestId("search-name").fill(SEARCH_NAME);
  await page.getByTestId("search-location").fill("Bermondsey — SE1, SE16");
  await editor.getByRole("button", { name: "Terraced" }).click();
  await page.getByTestId("search-keywords").fill("bright period terrace");

  // 3. The live email preview reflects the brief.
  // Fire the toggle's click handler directly: the editor body scrolls and the
  // toggle is its last child, which defeats Playwright's center-point hit-test.
  // el.click() invokes the same React onClick without pixel hit-testing.
  await page
    .getByTestId("search-preview-toggle")
    .evaluate((el) => (el as HTMLElement).click());
  const preview = page.getByTestId("search-email-preview");
  await expect(preview).toContainText("Bermondsey");
  await expect(preview).toContainText("bright period terrace");

  // 4. Create persists → the card appears.
  await page.getByTestId("search-save").click();
  const card = page.locator(
    `[data-testid="search-card"][data-search-name="${SEARCH_NAME}"]`,
  );
  await expect(card).toHaveCount(1);

  // 5. Pausing asks first (relationship-safe), then flips to Paused.
  await card.getByTestId("search-status-pill").click();
  await expect(page.getByTestId("search-pause-confirm")).toBeVisible();
  await page.getByTestId("search-pause-confirm-btn").click();
  await expect(card.getByTestId("search-status-pill")).toContainText("Paused");

  // 6. Link-through → /listings scoped to the search's outcodes + banner.
  await card.getByTestId("search-homes-link").click();
  await expect(page).toHaveURL(/\/listings/);
  const banner = page.getByTestId("search-filter-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(SEARCH_NAME);
  await expect(banner.locator(".sf-oc")).toContainText(["SE1", "SE16"]);
  await expect(banner).toContainText("Paused");
  // The list is scoped to those outcodes — the seeded SE1 homes show.
  await expect(page.getByTestId("listing-row").first()).toBeVisible();

  // 7. "All listings" clears the filter.
  await page.getByTestId("search-filter-clear").click();
  await expect(page.getByTestId("search-filter-banner")).toHaveCount(0);
});

test("location type-ahead: typing a county suggests it (real index) and resolves outcodes", async ({
  page,
}) => {
  const TA_NAME = `E2E Search TA ${RUN_ID}`;
  await page.goto("/searches");
  await page.getByTestId("new-search").click();
  const editor = page.getByTestId("search-editor");
  await expect(editor).toBeVisible();

  await page.getByTestId("search-name").fill(TA_NAME);

  // Type a county name → the bundled UK index (via trpc.locations.suggest)
  // surfaces it as a DISTRICT suggestion with a catchment hint.
  await page.getByTestId("search-location").fill("Conwy");
  const suggestions = page.getByTestId("search-location-suggestions");
  await expect(suggestions).toBeVisible();
  const conwy = suggestions
    .locator('[data-testid="search-location-suggestion"][data-kind="district"]')
    .filter({ hasText: "Conwy" })
    .first();
  await expect(conwy).toBeVisible();
  await expect(conwy).toContainText("outcodes");

  // Picking it stores the canonical label + closes the list.
  await conwy.click();
  await expect(page.getByTestId("search-location")).toHaveValue("Conwy");
  await expect(suggestions).toHaveCount(0);

  // Saving resolves "Conwy" → its outcodes server-side, so the card's Launch is
  // enabled (Launch is disabled only when a search resolved zero outcodes).
  await page.getByTestId("search-save").click();
  const card = page.locator(
    `[data-testid="search-card"][data-search-name="${TA_NAME}"]`,
  );
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("search-launch")).toBeEnabled();
});

test("delete cascade: confirm shows the home + agent counts, then hides the homes (Dismissed) and removes the search", async ({
  page,
}) => {
  // Create the search over the dedicated ZZ9 patch (seeded in beforeAll with one
  // listing + one agent), through the UI — proving create + the cascade
  // end-to-end. The location text carries the verbatim ZZ9 token, so the search
  // resolves to exactly {ZZ9}.
  await page.goto("/searches");
  await expect(page.getByRole("heading", { name: "Searches" })).toBeVisible();
  await page.getByTestId("new-search").click();
  const editor = page.getByTestId("search-editor");
  await expect(editor).toBeVisible();
  await page.getByTestId("search-name").fill(CASCADE_SEARCH_NAME);
  await page.getByTestId("search-location").fill(`Test patch — ${CASCADE_OUTCODE}`);
  await page.getByTestId("search-save").click();

  const card = page.locator(
    `[data-testid="search-card"][data-search-name="${CASCADE_SEARCH_NAME}"]`,
  );
  await expect(card).toHaveCount(1);

  // Open the editor (clicking the card opens it) and trigger delete.
  await card.click();
  await expect(page.getByTestId("search-editor")).toBeVisible();
  await page.getByTestId("search-delete").click();

  // The cascade confirm modal shows the exact counts removalPreview computed: the
  // ONE seeded ZZ9 home will be hidden, the ONE seeded ZZ9 agent removed (operator
  // path — the agent covers only ZZ9, so no other search keeps it).
  const confirm = page.getByTestId("search-remove-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("1");
  // Both nouns are named so the operator knows what the cascade touches.
  await expect(confirm).toContainText(/home/i);
  await expect(confirm).toContainText(/agent/i);

  await page.getByTestId("search-remove-confirm-btn").click();

  // The search card is gone (the cascade deleted the Search row).
  await expect(card).toHaveCount(0);

  // The search's homes are now HIDDEN for the owner → they surface under the
  // Dismissed bucket on /listings (hidden, never deleted). Buckets are FILTER
  // CHIPS over a single switching view, so select the Dismissed chip first, then
  // assert the row (only the selected bucket's rows are in the DOM).
  await page.goto("/listings");
  await expect(page.getByTestId("listings-table")).toBeVisible();
  await page.getByTestId("bucket-dismissed").click();
  await expect(page.getByTestId("bucket-dismissed")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const dismissedRow = page.locator(
    `[data-testid="listing-row"][data-address="${CASCADE_ADDRESS}"]`,
  );
  await expect(dismissedRow).toBeVisible();
  // It carries a Restore control (it is in the Dismissed bucket, recoverable).
  await expect(dismissedRow.getByTestId("listing-restore")).toHaveCount(1);

  // Belt-and-braces: the agent was completely removed from the global pool.
  const agentsLeft = await withClient(async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "Agent" WHERE email = $1`,
      [CASCADE_AGENT_EMAIL],
    );
    return Number(rows[0]?.count ?? "0");
  });
  expect(agentsLeft).toBe(0);
});
