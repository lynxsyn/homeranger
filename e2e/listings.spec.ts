/**
 * Listings-table E2E — the HomeScout design (claude.ai/design handoff) on the
 * real read path. The product loop is discover → outreach → ingest → list, so
 * the table has NO search filters: just the seeded homes, sortable, in a table
 * or card view, with each row linking back to the agent's source page.
 *
 * Covers:
 *   - loads the seeded listings into the table (one row per fixture);
 *   - has NO filter controls (the M3 outcode/price/beds inputs are gone);
 *   - sorts by price (dropdown + column-header click, both directions) and
 *     asserts the actual rendered row order;
 *   - every row shows a match-score ring;
 *   - a source-link cell points at listingUrl (new tab); a pre-market row with
 *     a null listingUrl renders an email-only marker, not a broken link;
 *   - the table ⇄ card view toggle switches the rendered view;
 *   - the theme toggle flips <html data-theme> and persists across a reload.
 *
 * Auth: the api webServer runs with CF_ACCESS_* unset → dev bypass, so every
 * tRPC call is authenticated as DEV_USER_EMAIL. No login / storageState.
 */
import { expect, test } from "@playwright/test";
import { LISTING_FIXTURES } from "./fixtures/listings.fixture.js";

/** Fixture addresses in price-descending order (the sort assertion target). */
const PRICE_DESC = [...LISTING_FIXTURES]
  .sort((a, b) => (b.pricePence ?? -1) - (a.pricePence ?? -1))
  .map((l) => l.addressNormalized);
const PRICE_ASC = [...PRICE_DESC].reverse();

async function renderedAddresses(page: import("@playwright/test").Page) {
  return page
    .getByTestId("listing-row")
    .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-address") ?? ""));
}

test.beforeEach(async ({ page }) => {
  await page.goto("/listings");
  await expect(page.getByTestId("listings-table")).toBeVisible();
});

test("loads the seeded listings with a per-row score ring and no filters", async ({
  page,
}) => {
  await expect(page.getByTestId("listing-row")).toHaveCount(LISTING_FIXTURES.length);
  await expect(
    page.locator('[data-testid="listing-row"][data-address="pre market flat se1"]'),
  ).toHaveCount(1);

  // Every row renders a match-score ring (the design's signature element).
  await expect(page.getByTestId("match-score")).toHaveCount(LISTING_FIXTURES.length);

  // The count bar reflects the seeded set (one pre-market fixture).
  await expect(page.getByTestId("listings-count")).toContainText("1 pre-market");

  // No filter controls — the table is filter-free by design.
  await expect(page.getByTestId("filter-outcode")).toHaveCount(0);
  await expect(page.getByTestId("filter-max-price")).toHaveCount(0);
  await expect(page.getByTestId("filter-min-beds")).toHaveCount(0);
});

test("sorts by price (descending) from the dropdown in rendered row order", async ({
  page,
}) => {
  await page.getByTestId("sort-by").selectOption("price");
  await expect(page.getByTestId("listing-row")).toHaveCount(LISTING_FIXTURES.length);
  expect(await renderedAddresses(page)).toEqual(PRICE_DESC);
});

test("a column header toggles the sort direction on click", async ({ page }) => {
  const priceHeader = page.getByRole("columnheader", { name: "Price" });
  await priceHeader.click();
  expect(await renderedAddresses(page)).toEqual(PRICE_DESC);
  await priceHeader.click();
  expect(await renderedAddresses(page)).toEqual(PRICE_ASC);
});

test("a source-link cell points at listingUrl (new tab)", async ({ page }) => {
  const rivington = page.locator(
    '[data-testid="listing-row"][data-address="rivington street se1"]',
  );
  const link = rivington.getByTestId("listing-source-link");
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute(
    "href",
    "https://listings.example.test/rivington-se1",
  );
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noreferrer/);
});

test("a pre-market row with null listingUrl renders an email-only marker, not a link", async ({
  page,
}) => {
  const preMarket = page.locator(
    '[data-testid="listing-row"][data-address="pre market flat se1"]',
  );
  await expect(preMarket).toHaveCount(1);
  await expect(preMarket.getByTestId("listing-source-link")).toHaveCount(0);
  await expect(preMarket.getByTestId("listing-source-none")).toHaveCount(1);
});

test("the view toggle switches between table and card views", async ({ page }) => {
  await page.getByTestId("view-cards").click();
  await expect(page.getByTestId("listings-table")).toHaveCount(0);
  await expect(page.locator(".grid-cards")).toBeVisible();
  await expect(page.getByTestId("listing-row")).toHaveCount(LISTING_FIXTURES.length);

  await page.getByTestId("view-table").click();
  await expect(page.getByTestId("listings-table")).toBeVisible();
});

test("the theme toggle flips <html data-theme> and persists across reload", async ({
  page,
}) => {
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "light");

  await page.getByTestId("theme-toggle").click();
  await expect(html).toHaveAttribute("data-theme", "dark");

  // The pre-paint script in index.html restores the stored theme on reload.
  await page.reload();
  await expect(page.getByTestId("listings-table")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
