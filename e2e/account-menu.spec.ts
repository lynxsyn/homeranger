/**
 * Account menu + Settings E2E. The editorial top-nav, the avatar dropdown, the
 * Searches rename, and the "Your details" profile flowing end-to-end into the
 * outreach draft, against real infra (api + pgvector via the Playwright
 * webServer, dev-bypass auth).
 *
 * Covers:
 *   1. Navigation lives in the TOPBAR: Listings, Searches and Agents are
 *      editorial-underline tabs (operator sees all three), the "New search" CTA
 *      sits in the topbar, and the avatar dropdown now carries ONLY Settings +
 *      Theme + Sign out. The three tabs route; Settings is reached via the
 *      avatar.
 *   2. The campaign concept reads "Searches" everywhere user-facing (heading +
 *      New search), while the route stays /searches (internal).
 *   3. Saving the buyer's details persists (survives reload) and the saved
 *      identity signs + paces the live outreach email preview, proving the
 *      Settings -> preferences.get -> draft wiring end-to-end through the API.
 *
 * Identity is reset in afterAll so the shared SearchProfile singleton does not
 * leak a name into the other specs' drafts (single-worker, serial run).
 */
import { expect, test } from "@playwright/test";
import { Client } from "pg";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://homeranger:homeranger@localhost:5434/homeranger";

// The search editor is a tall form; a desktop-height viewport keeps its
// scrollable body (and the preview toggle) comfortably in view.
test.use({ viewport: { width: 1280, height: 1000 } });

test.afterAll(async () => {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE "SearchProfile"
       SET "firstName" = '', "lastName" = '', "phone" = '', "urgency" = 'active'`,
    );
  } finally {
    await client.end();
  }
});

test("topbar tabs route to Listings/Searches/Agents; the avatar carries Settings", async ({
  page,
}) => {
  await page.goto("/listings");

  // Navigation now lives in the topbar as editorial-underline tabs: Listings,
  // Searches and Agents (the operator dev-bypass user sees all three). The
  // avatar dropdown no longer carries Listings/Searches.
  await expect(page.getByTestId("nav-listings")).toBeVisible();
  await expect(page.getByTestId("nav-searches")).toBeVisible();
  await expect(page.getByTestId("nav-agents")).toBeVisible();

  // Searches tab → /searches route, "Searches" heading (the page-head title is
  // now an sr-only h1, so getByRole still resolves it).
  await page.getByTestId("nav-searches").click();
  await expect(page).toHaveURL(/\/searches/);
  await expect(page.getByRole("heading", { name: "Searches" })).toBeVisible();
  // The "New search" CTA lives in the topbar (unscoped) and is always visible.
  await expect(page.getByTestId("new-search")).toHaveText(/New search/);

  // Agents tab → /agents route.
  await page.getByTestId("nav-agents").click();
  await expect(page).toHaveURL(/\/agents/);

  // Settings is no longer a tab; it is reached via the avatar dropdown.
  await page.getByTestId("account-avatar").click();
  const menu = page.getByTestId("account-menu");
  await expect(menu.getByTestId("nav-settings")).toHaveText("Settings");
  // The dropdown still carries the Theme toggle (it stays in the menu).
  await expect(menu.getByTestId("theme-toggle")).toContainText("Theme");
  // Listings/Searches are NOT in the avatar menu any more; they are topbar tabs.
  await expect(menu.getByTestId("nav-listings")).toHaveCount(0);
  await expect(menu.getByTestId("nav-searches")).toHaveCount(0);

  await menu.getByTestId("nav-settings").click();
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();

  // Back to Listings via the topbar tab.
  await page.getByTestId("nav-listings").click();
  await expect(page).toHaveURL(/\/listings/);
});

test("settings details persist and sign + pace the outreach draft", async ({
  page,
}) => {
  await page.goto("/settings");

  // 1. Fill the buyer's details + an urgency, then save.
  await page.getByTestId("settings-first-name").fill("Jane");
  await page.getByTestId("settings-last-name").fill("Whitfield");
  await page.getByTestId("settings-phone").fill("07700 900123");
  await page.getByTestId("urgency-ready").click();

  // The live preview reflects the edit before saving.
  await expect(page.getByTestId("settings-signature")).toContainText(
    "Jane Whitfield",
  );
  await expect(page.getByTestId("settings-urgency-line")).toContainText(
    "I'm in a strong position to proceed",
  );

  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-saved")).toBeVisible();

  // 2. Persisted: a reload re-seeds the saved identity from the real API.
  await page.reload();
  await expect(page.getByTestId("settings-first-name")).toHaveValue("Jane");
  await expect(page.getByTestId("settings-phone")).toHaveValue("07700 900123");

  // 3. End-to-end: the saved identity signs + paces the search email preview.
  await page.goto("/searches");
  await page.getByTestId("new-search").click();
  const editor = page.getByTestId("search-editor");
  await expect(editor).toBeVisible();
  // el.click() invokes the React onClick without pixel hit-testing (the editor
  // body scrolls and the toggle is its last child).
  await page
    .getByTestId("search-preview-toggle")
    .evaluate((el) => (el as HTMLElement).click());
  const preview = page.getByTestId("search-email-preview");
  await expect(preview).toContainText("Many thanks,");
  await expect(preview).toContainText("Jane Whitfield");
  await expect(preview).toContainText("07700 900123");
  await expect(preview).toContainText("I'm in a strong position to proceed");
});
