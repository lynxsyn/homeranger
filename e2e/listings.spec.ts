/**
 * M3 listings-table E2E (spec test plan, E2E rows).
 *
 * Covers:
 *   - loads the seeded listings into the table;
 *   - filters by outcode (SE1) + max price (£600,000) → only the SE1 rows
 *     under the ceiling render (Hatfields at £845k is excluded);
 *   - sorts by match score (the combinedScore default) without error;
 *   - clicks a source-link cell → asserts href/target/rel point at listingUrl;
 *   - a pre-market row with a null listingUrl renders WITHOUT a broken link
 *     (a `listing-source-none` placeholder, no `<a>`).
 *
 * Auth: the api webServer runs with CF_ACCESS_* unset → dev bypass, so every
 * tRPC call is authenticated as DEV_USER_EMAIL. No login / storageState.
 */
import { expect, test } from "@playwright/test";
import {
  FILTER_MAX_PRICE_PENCE,
  LISTING_FIXTURES,
  SE1_UNDER_600K,
} from "./fixtures/listings.fixture.js";

const POUNDS_CEILING = String(FILTER_MAX_PRICE_PENCE / 100); // "600000"

test.beforeEach(async ({ page }) => {
  await page.goto("/listings");
  await expect(page.getByTestId("listings-table")).toBeVisible();
});

test("loads the seeded listings", async ({ page }) => {
  // Every seeded fixture has a distinct addressNormalized → one row each.
  await expect(page.getByTestId("listing-row")).toHaveCount(
    LISTING_FIXTURES.length,
  );
  // The pre-market null-URL row's address is present.
  await expect(
    page.locator('[data-testid="listing-row"][data-address="pre market flat se1"]'),
  ).toHaveCount(1);
});

test("filters by outcode + max price", async ({ page }) => {
  await page.getByTestId("filter-outcode").fill("SE1");
  await page.getByTestId("filter-max-price").fill(POUNDS_CEILING);

  // Sanity: the expected post-filter set excludes the £845k SE1 row and the
  // M3 (Manchester) row. £600,000 = 60,000,000 pence (NOT 6,000,000).
  expect(FILTER_MAX_PRICE_PENCE).toBe(60_000_000);
  const expectedAddresses = SE1_UNDER_600K.map((l) => l.addressNormalized);
  expect(expectedAddresses).toContain("rivington street se1");
  expect(expectedAddresses).toContain("union street se1");
  expect(expectedAddresses).toContain("pre market flat se1");
  expect(expectedAddresses).not.toContain("hatfields se1");

  await expect(page.getByTestId("listing-row")).toHaveCount(
    SE1_UNDER_600K.length,
  );
  await expect(
    page.locator('[data-testid="listing-row"][data-address="hatfields se1"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid="listing-row"][data-address="deansgate m3"]'),
  ).toHaveCount(0);
});

test("sorts by match score (combinedScore default)", async ({ page }) => {
  await page.getByTestId("sort-by").selectOption("combinedScore");
  // The table still renders all rows after re-sorting (combinedScore is the
  // UI default; ordering is a stable fallback until M5 supplies scores).
  await expect(page.getByTestId("listing-row")).toHaveCount(
    LISTING_FIXTURES.length,
  );
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

test("a pre-market row with null listingUrl renders without a broken link", async ({
  page,
}) => {
  const preMarket = page.locator(
    '[data-testid="listing-row"][data-address="pre market flat se1"]',
  );
  await expect(preMarket).toHaveCount(1);
  // No anchor in the source cell — a placeholder span instead.
  await expect(preMarket.getByTestId("listing-source-link")).toHaveCount(0);
  await expect(preMarket.getByTestId("listing-source-none")).toHaveCount(1);
});
