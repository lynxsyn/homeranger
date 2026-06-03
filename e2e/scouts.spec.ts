/**
 * Scouts E2E (M8 PR1) — the golden path for the new /scouts route + the
 * scout→listings link-through, against real infra (api + pgvector via the
 * Playwright webServer, dev-bypass auth).
 *
 * Covers:
 *   1. /scouts renders; "New scout" opens the editor;
 *   2. filling the brief updates the LIVE outreach email preview;
 *   3. Create persists (the scout card appears);
 *   4. the status pill opens the relationship-safe pause-confirm, and
 *      confirming flips the scout to Paused;
 *   5. "View homes found" navigates to /listings filtered by the scout's
 *      resolved outcodes, shows the scout-filter banner (name + outcodes +
 *      Paused status), and "All listings" clears it.
 *
 * The scout is created through the UI (proving create end-to-end) under a
 * unique, prefixed name; afterAll deletes every `E2E Scout%` row so the run is
 * idempotent and does not pollute other specs.
 */
import { expect, test } from "@playwright/test";
import { Client } from "pg";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://homeranger:homeranger@localhost:5434/homeranger";

const RUN_ID = Date.now().toString(36);
const SCOUT_NAME = `E2E Scout ${RUN_ID}`;

// The editor is a tall form; give it a desktop-height viewport so its scrollable
// body comfortably shows the outreach-preview toggle (the default 720px clips it).
test.use({ viewport: { width: 1280, height: 1000 } });

test.afterAll(async () => {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await client.query(`DELETE FROM "Scout" WHERE "name" LIKE 'E2E Scout%'`);
  } finally {
    await client.end();
  }
});

test("scout golden path: create → live email preview → pause-confirm → link-through", async ({
  page,
}) => {
  await page.goto("/scouts");
  await expect(page.getByRole("heading", { name: "Searches" })).toBeVisible();

  // 1. Open the editor.
  await page.getByTestId("new-scout").click();
  const editor = page.getByTestId("scout-editor");
  await expect(editor).toBeVisible();

  // 2. Fill the brief — a location whose outcodes (SE1, SE16) match seeded homes.
  await page.getByTestId("scout-name").fill(SCOUT_NAME);
  await page.getByTestId("scout-location").fill("Bermondsey — SE1, SE16");
  await editor.getByRole("button", { name: "Terraced" }).click();
  await page.getByTestId("scout-keywords").fill("bright period terrace");

  // 3. The live email preview reflects the brief.
  // Fire the toggle's click handler directly: the editor body scrolls and the
  // toggle is its last child, which defeats Playwright's center-point hit-test.
  // el.click() invokes the same React onClick without pixel hit-testing.
  await page
    .getByTestId("scout-preview-toggle")
    .evaluate((el) => (el as HTMLElement).click());
  const preview = page.getByTestId("scout-email-preview");
  await expect(preview).toContainText("Bermondsey");
  await expect(preview).toContainText("bright period terrace");

  // 4. Create persists → the card appears.
  await page.getByTestId("scout-save").click();
  const card = page.locator(
    `[data-testid="scout-card"][data-scout-name="${SCOUT_NAME}"]`,
  );
  await expect(card).toHaveCount(1);

  // 5. Pausing asks first (relationship-safe), then flips to Paused.
  await card.getByTestId("scout-status-pill").click();
  await expect(page.getByTestId("scout-pause-confirm")).toBeVisible();
  await page.getByTestId("scout-pause-confirm-btn").click();
  await expect(card.getByTestId("scout-status-pill")).toContainText("Paused");

  // 6. Link-through → /listings scoped to the scout's outcodes + banner.
  await card.getByTestId("scout-homes-link").click();
  await expect(page).toHaveURL(/\/listings/);
  const banner = page.getByTestId("scout-filter-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(SCOUT_NAME);
  await expect(banner.locator(".sf-oc")).toContainText(["SE1", "SE16"]);
  await expect(banner).toContainText("Paused");
  // The list is scoped to those outcodes — the seeded SE1 homes show.
  await expect(page.getByTestId("listing-row").first()).toBeVisible();

  // 7. "All listings" clears the filter.
  await page.getByTestId("scout-filter-clear").click();
  await expect(page.getByTestId("scout-filter-banner")).toHaveCount(0);
});

test("location type-ahead: typing a county suggests it (real index) and resolves outcodes", async ({
  page,
}) => {
  const TA_NAME = `E2E Scout TA ${RUN_ID}`;
  await page.goto("/scouts");
  await page.getByTestId("new-scout").click();
  const editor = page.getByTestId("scout-editor");
  await expect(editor).toBeVisible();

  await page.getByTestId("scout-name").fill(TA_NAME);

  // Type a county name → the bundled UK index (via trpc.locations.suggest)
  // surfaces it as a DISTRICT suggestion with a catchment hint.
  await page.getByTestId("scout-location").fill("Conwy");
  const suggestions = page.getByTestId("scout-location-suggestions");
  await expect(suggestions).toBeVisible();
  const conwy = suggestions
    .locator('[data-testid="scout-location-suggestion"][data-kind="district"]')
    .filter({ hasText: "Conwy" })
    .first();
  await expect(conwy).toBeVisible();
  await expect(conwy).toContainText("outcodes");

  // Picking it stores the canonical label + closes the list.
  await conwy.click();
  await expect(page.getByTestId("scout-location")).toHaveValue("Conwy");
  await expect(suggestions).toHaveCount(0);

  // Saving resolves "Conwy" → its outcodes server-side, so the card's Launch is
  // enabled (Launch is disabled only when a scout resolved zero outcodes).
  await page.getByTestId("scout-save").click();
  const card = page.locator(
    `[data-testid="scout-card"][data-scout-name="${TA_NAME}"]`,
  );
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("scout-launch")).toBeEnabled();
});
