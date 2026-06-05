/**
 * Sources screen E2E (Sources tab). The crawled-listing-SOURCE catalogue on the
 * real read path, against real infra (api + pgvector via the Playwright
 * webServer, dev-bypass auth). Sources is a GLOBAL, read-only catalogue gated by
 * protectedProcedure (any authenticated user), so unlike the operator-only
 * Agents tab the nav button is always visible.
 *
 * Sources are the genuinely-wired listing-scrape sites (PR #80/#81/#82):
 * Auction House (auction) and UK Land & Farms (land). Each row folds in DERIVED
 * telemetry from real data — lotsFound = COUNT(ListingSourceRecord), latest lot
 * = MAX(observedAt) — plus the configured coverage outcodes from REGION_TAXONOMY.
 * The seed (apps/api/prisma/seed.ts) upserts scraped lots WITH ListingSourceRecord
 * rows (in the shared LISTING_FIXTURES), so this screen has real per-source
 * counts to render: 2 auctionhouse lots + 1 uklandandfarms lot.
 *
 * Covers:
 *   1. The topbar Sources tab navigates to /sources and the page renders: the
 *      metrics strip (Monitored sources / Lots ingested / Latest activity), the
 *      sr-only "Sources" heading, and EXACTLY 2 source rows (the catalogue is a
 *      fixed 2-element config, so a hard count is valid here — unlike agents).
 *   2. The kind-filter chips (All / Auction houses / Land & farm) narrow the
 *      table to the matching kind and All restores both rows.
 *   3. Drilling in from a source's "View N lots" link lands on /listings WITH the
 *      source filter banner; the listings narrow to that source (every visible
 *      row's From cell shows the source name); clearing the banner restores all.
 *
 * Stable locators only (testids + data-source). The catalogue count is fixed at
 * 2 so it is asserted exactly; per-source lot counts are read from the page, not
 * hard-coded, so a seed refresh does not flake. Where a sticky / scrolled
 * control defeats the center-point hit-test we invoke the React onClick via
 * el.click() (the same documented workaround the listings + agents specs use).
 *
 * Auth: the api webServer runs with CF_ACCESS_* unset → dev bypass, so every
 * tRPC call is authenticated as DEV_USER_EMAIL and `nav-sources` is visible.
 */
import { expect, test } from "@playwright/test";

// The sources table + metrics strip are a tall page; a desktop-height viewport
// keeps the filter chips and table body reachable without a fragile scroll dance.
test.use({ viewport: { width: 1280, height: 1000 } });

/** The data-source of every rendered source row, in render order. */
async function renderedSources(page: import("@playwright/test").Page) {
  return page
    .getByTestId("source-row")
    .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-source") ?? ""));
}

test("the Sources tab renders the metrics strip and exactly two source rows", async ({
  page,
}) => {
  // Start on Listings; the Sources tab is a topbar tab visible to any authed
  // user (no operator flag), so the dev-bypass identity sees it.
  await page.goto("/listings");
  await expect(page.getByTestId("listings-table")).toBeVisible();

  await page.getByTestId("nav-sources").click();
  await expect(page).toHaveURL(/\/sources/);

  // The metrics strip renders all three tiles.
  await expect(page.getByTestId("sources-metric-sources")).toBeVisible();
  await expect(page.getByTestId("sources-metric-lots")).toBeVisible();
  await expect(page.getByTestId("sources-metric-latest")).toBeVisible();

  // The accessible heading survives the page-head removal (sr-only h1).
  await expect(page.getByRole("heading", { name: "Sources" })).toBeVisible();

  // The catalogue is a FIXED 2-element config (Auction House + UK Land & Farms),
  // so a hard count is valid here (unlike the agents pool, which is seed-sized).
  await expect(page.getByTestId("sources-table")).toBeVisible();
  await expect(page.getByTestId("source-row")).toHaveCount(2);
  await expect(page.getByTestId("sources-empty")).toHaveCount(0);

  // The count line agrees with the rendered rows.
  await expect(page.getByTestId("sources-count")).toContainText("2");
});

test("a kind-filter chip narrows the table to that kind, and All restores both", async ({
  page,
}) => {
  await page.goto("/sources");
  await expect(page.getByTestId("sources-table")).toBeVisible();

  const allSources = await renderedSources(page);
  expect(allSources).toHaveLength(2);

  // Filter to Auction houses. Invoke the chip's React onClick directly: the chip
  // sits in a controls row that can scroll under the sticky topbar.
  await page
    .getByTestId("source-filter-auction")
    .evaluate((el) => (el as HTMLElement).click());
  await expect(page.getByTestId("source-filter-auction")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const auctionRows = page.getByTestId("source-row");
  await expect(auctionRows).toHaveCount(1);
  await expect(auctionRows.first()).toHaveAttribute(
    "data-source",
    "auctionhouse",
  );

  // Filter to Land & farm → only the land source.
  await page
    .getByTestId("source-filter-land")
    .evaluate((el) => (el as HTMLElement).click());
  await expect(page.getByTestId("source-filter-land")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const landRows = page.getByTestId("source-row");
  await expect(landRows).toHaveCount(1);
  await expect(landRows.first()).toHaveAttribute(
    "data-source",
    "uklandandfarms",
  );

  // All restores both rows.
  await page
    .getByTestId("source-filter-all")
    .evaluate((el) => (el as HTMLElement).click());
  await expect(page.getByTestId("source-filter-all")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("source-row")).toHaveCount(2);
  expect(await renderedSources(page)).toEqual(allSources);
});

test("drilling in from a source's View N lots link filters /listings, and clear restores all", async ({
  page,
}) => {
  // Baseline: the full listings count (the source drill-in must be a subset).
  await page.goto("/listings");
  await expect(page.getByTestId("listings-table")).toBeVisible();
  const allCount = await page.getByTestId("listing-row").count();
  expect(allCount).toBeGreaterThan(0);

  // Go to Sources and drill in from the Auction House row's "View N lots" link.
  await page.goto("/sources");
  await expect(page.getByTestId("sources-table")).toBeVisible();
  const auctionRow = page.locator(
    `[data-testid="source-row"][data-source="auctionhouse"]`,
  );
  await expect(auctionRow).toHaveCount(1);

  // The "View N lots" button calls onViewLots → navigates to /listings. It sits
  // in a scrollable row, so invoke the React onClick directly.
  await auctionRow
    .getByTestId("source-lots-link")
    .evaluate((el) => (el as HTMLElement).click());

  // Landed on /listings WITH the source drill-in banner naming the source.
  await expect(page).toHaveURL(/\/listings/);
  const banner = page.getByTestId("source-filter-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Auction House");

  // Scoped to the source → a non-empty, subset-or-equal view, and every visible
  // row's From cell shows the source name (not an agency, not a dash).
  await expect(page.getByTestId("listings-table")).toBeVisible();
  const scopedRows = page.getByTestId("listing-row");
  const scopedCount = await scopedRows.count();
  expect(scopedCount).toBeGreaterThan(0);
  expect(scopedCount).toBeLessThanOrEqual(allCount);
  for (const fromCell of await scopedRows.locator(".agent-cell").all()) {
    await expect(fromCell).toContainText("Auction House");
  }

  // Clearing the drill-in returns to the full listings set with no banner.
  await page
    .getByTestId("source-filter-clear")
    .evaluate((el) => (el as HTMLElement).click());
  await expect(page.getByTestId("source-filter-banner")).toHaveCount(0);
  await expect(page.getByTestId("listing-row").first()).toBeVisible();
  expect(await page.getByTestId("listing-row").count()).toBe(allCount);
});
