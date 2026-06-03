/**
 * Account menu + Settings E2E — the avatar dropdown navigation, the
 * Scouts→Searches rename, and the "Your details" profile flowing end-to-end
 * into the outreach draft, against real infra (api + pgvector via the Playwright
 * webServer, dev-bypass auth).
 *
 * Covers:
 *   1. The top bar is just the logo + avatar; the dropdown carries Listings,
 *      Searches, Settings, and the Theme toggle, and navigates between them.
 *   2. The campaign concept reads "Searches" everywhere user-facing (heading +
 *      New search), while the route stays /scouts (internal).
 *   3. Saving the buyer's details persists (survives reload) and the saved
 *      identity signs + paces the live outreach email preview — proving the
 *      Settings → preferences.get → draft wiring end-to-end through the real API.
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

test("account dropdown navigates between Listings, Searches and Settings", async ({
  page,
}) => {
  await page.goto("/listings");

  // The old inline nav is gone — open the avatar to reveal the menu.
  await page.getByTestId("account-avatar").click();
  const menu = page.getByTestId("account-menu");
  await expect(menu.getByTestId("nav-listings")).toHaveText("Listings");
  await expect(menu.getByTestId("nav-scouts")).toHaveText("Searches");
  await expect(menu.getByTestId("nav-settings")).toHaveText("Settings");
  await expect(menu.getByTestId("theme-toggle")).toContainText("Theme");

  // Searches → /scouts route, "Searches" heading (rename is user-facing only).
  await menu.getByTestId("nav-scouts").click();
  await expect(page).toHaveURL(/\/scouts/);
  await expect(page.getByRole("heading", { name: "Searches" })).toBeVisible();
  await expect(page.getByTestId("new-scout")).toHaveText(/New search/);

  // Settings → /settings, "Your details".
  await page.getByTestId("account-avatar").click();
  await page.getByTestId("nav-settings").click();
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();

  // Back to Listings via the menu.
  await page.getByTestId("account-avatar").click();
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
  await page.goto("/scouts");
  await page.getByTestId("new-scout").click();
  const editor = page.getByTestId("scout-editor");
  await expect(editor).toBeVisible();
  // el.click() invokes the React onClick without pixel hit-testing (the editor
  // body scrolls and the toggle is its last child).
  await page
    .getByTestId("scout-preview-toggle")
    .evaluate((el) => (el as HTMLElement).click());
  const preview = page.getByTestId("scout-email-preview");
  await expect(preview).toContainText("Many thanks,");
  await expect(preview).toContainText("Jane Whitfield");
  await expect(preview).toContainText("07700 900123");
  await expect(preview).toContainText("I'm in a strong position to proceed");
});
