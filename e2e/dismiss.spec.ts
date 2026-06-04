/**
 * Listing dismiss / restore E2E — the "hide a home from my feed" loop on the
 * real read path (api + pgvector via the Playwright webServer, dev-bypass auth).
 *
 * A dismiss is a PER-USER overlay on the GLOBAL Listing catalogue (the exact
 * mirror of the bookmark/save overlay, opposite intent): the home is HIDDEN from
 * the buyer's Active feed, never deleted, and is recoverable from the Dismissed
 * bucket. It is silent to the agent. Backed server-side by
 * listings.dismiss/restore + the listings.dismissed query.
 *
 * BUCKETS ARE FILTER CHIPS, NOT CONTAINERS. `bucket-active` / `bucket-saved` /
 * `bucket-dismissed` are <button class="sf-chip"> chips; the selected one has
 * aria-pressed="true" and each carries its count in a `.sf-chip__n` child.
 * Clicking a chip switches the SINGLE rows region (the `listings-table`, or the
 * `.grid-cards` in card view) to that bucket's rows — only the selected bucket's
 * `listing-row`s are in the DOM at a time. Active is the default on load.
 *
 * Covers:
 *   1. Dismiss from Active → the row leaves the Active view, the undo snackbar
 *      appears, the active chip count drops; Undo brings the row back + restores
 *      the count (optimistic + reversible).
 *   2. Dismiss again → active chip −1 / dismissed chip +1; switch to the
 *      Dismissed bucket → the row shows with a Restore control (no dismiss);
 *      Restore removes it from Dismissed and it returns to Active.
 *   3. A saved-then-dismissed home is in NEITHER the Saved nor the Active bucket
 *      (dismiss buries it regardless of bookmark state); restoring returns it to
 *      both, and unbookmarking leaves a clean baseline.
 *
 * Stable locators only (testids + data-address). The spec dismisses/restores a
 * SEEDED fixture row (union street se1), so no new seed rows are needed; afterAll
 * clears the operator's dismissed + saved overlays for that listing via a raw pg
 * Client so a reused local server (reuseExistingServer) starts clean — the seed
 * resets savedListing but NOT dismissedListing.
 */
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://homeranger:homeranger@localhost:5434/homeranger";

// A seeded fixture address (e2e/fixtures/listings.fixture.ts). It is a plain
// live SE1 home, so it starts in the Active bucket — the dismiss target.
const DISMISS_ADDRESS = "union street se1";

type BucketId = "active" | "saved" | "dismissed";

// The bucket chips + rows are a tall, scrollable page; a desktop-height viewport
// keeps the chips + table body reachable without a fragile scroll dance (the same
// reason the searches/agents specs widen the viewport).
test.use({ viewport: { width: 1280, height: 1000 } });

/** A listing row by its (normalised) address — present only when its bucket is selected. */
function row(page: Page, address: string) {
  return page.locator(
    `[data-testid="listing-row"][data-address="${address}"]`,
  );
}

/** Select a bucket filter chip and confirm it became the pressed (active) view. */
async function selectBucket(page: Page, id: BucketId): Promise<void> {
  await page.getByTestId(`bucket-${id}`).click();
  await expect(page.getByTestId(`bucket-${id}`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

/** The count rendered in a bucket chip's `.sf-chip__n` badge. */
async function bucketCount(page: Page, id: BucketId): Promise<number> {
  const text =
    (await page
      .getByTestId(`bucket-${id}`)
      .locator(".sf-chip__n")
      .textContent()) ?? "";
  const match = text.match(/\d+/);
  return match ? Number(match[0]) : 0;
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Clear the operator's overlays for the dismiss target so a reused local server
// (or a re-run) starts from a clean Active feed. The seed resets savedListing
// (userId NULL) but never dismissedListing, so without this the target would be
// stuck in Dismissed across runs. Operator dev-bypass → userId IS NULL.
async function resetOverlays(): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `DELETE FROM "DismissedListing"
         WHERE "userId" IS NULL
           AND "listingId" IN (
             SELECT id FROM "Listing" WHERE "addressNormalized" = $1)`,
      [DISMISS_ADDRESS],
    );
    await client.query(
      `DELETE FROM "SavedListing"
         WHERE "userId" IS NULL
           AND "listingId" IN (
             SELECT id FROM "Listing" WHERE "addressNormalized" = $1)`,
      [DISMISS_ADDRESS],
    );
  });
}

test.beforeAll(resetOverlays);
test.afterAll(resetOverlays);

test.beforeEach(async ({ page }) => {
  // Active is the default bucket on load.
  await page.goto("/listings");
  await expect(page.getByTestId("listings-table")).toBeVisible();
  await expect(page.getByTestId("bucket-active")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("dismiss from Active shows the undo snackbar, and Undo brings the row back", async ({
  page,
}) => {
  // The target is in the (default) Active view.
  await expect(row(page, DISMISS_ADDRESS)).toBeVisible();
  const activeBefore = await bucketCount(page, "active");

  // Dismiss the row from its in-row control.
  await row(page, DISMISS_ADDRESS).getByTestId("listing-dismiss").click();

  // The undo snackbar appears, the row leaves the Active view, and the active
  // chip count drops by one.
  await expect(page.getByTestId("dismiss-toast")).toBeVisible();
  await expect(row(page, DISMISS_ADDRESS)).toHaveCount(0);
  await expect.poll(() => bucketCount(page, "active")).toBe(activeBefore - 1);

  // Undo restores it straight back into Active and the count recovers.
  await page.getByTestId("dismiss-undo").click();
  await expect(row(page, DISMISS_ADDRESS)).toBeVisible();
  await expect.poll(() => bucketCount(page, "active")).toBe(activeBefore);
});

test("dismiss moves the home to the Dismissed bucket; Restore moves it back out", async ({
  page,
}) => {
  // Baseline chip counts (derived from the page, never hard-coded against the
  // seed, so a fixture refresh does not flake the run).
  const activeBefore = await bucketCount(page, "active");
  const dismissedBefore = await bucketCount(page, "dismissed");
  await expect(row(page, DISMISS_ADDRESS)).toBeVisible();

  // Dismiss — the active chip drops one, the dismissed chip gains one.
  await row(page, DISMISS_ADDRESS).getByTestId("listing-dismiss").click();
  await expect(page.getByTestId("dismiss-toast")).toBeVisible();
  await expect.poll(() => bucketCount(page, "active")).toBe(activeBefore - 1);
  await expect
    .poll(() => bucketCount(page, "dismissed"))
    .toBe(dismissedBefore + 1);

  // Switch to the Dismissed bucket: the row is now visible there and its in-row
  // control is Restore, NOT dismiss (the per-bucket control swaps).
  await selectBucket(page, "dismissed");
  await expect(row(page, DISMISS_ADDRESS)).toBeVisible();
  await expect(
    row(page, DISMISS_ADDRESS).getByTestId("listing-restore"),
  ).toHaveCount(1);
  await expect(
    row(page, DISMISS_ADDRESS).getByTestId("listing-dismiss"),
  ).toHaveCount(0);

  // Restore → the row leaves the Dismissed view; the chip counts return to
  // baseline and the row is back in Active.
  await row(page, DISMISS_ADDRESS).getByTestId("listing-restore").click();
  await expect(row(page, DISMISS_ADDRESS)).toHaveCount(0);
  await expect
    .poll(() => bucketCount(page, "dismissed"))
    .toBe(dismissedBefore);
  await expect.poll(() => bucketCount(page, "active")).toBe(activeBefore);

  await selectBucket(page, "active");
  await expect(row(page, DISMISS_ADDRESS)).toBeVisible();
});

test("a saved-then-dismissed home is in NEITHER the Saved nor the Active bucket", async ({
  page,
}) => {
  // Bookmark the target first — it joins the Saved bucket (per-user, server-side).
  await row(page, DISMISS_ADDRESS).getByTestId("interest-button").click();
  await selectBucket(page, "saved");
  await expect(row(page, DISMISS_ADDRESS)).toBeVisible();

  // Back to Active and dismiss it. Dismiss buries a home regardless of bookmark
  // state, so it drops out of BOTH Active and Saved and shows only under Dismissed.
  await selectBucket(page, "active");
  const dismissedBefore = await bucketCount(page, "dismissed");
  await row(page, DISMISS_ADDRESS).getByTestId("listing-dismiss").click();
  await expect(page.getByTestId("dismiss-toast")).toBeVisible();

  // Absent from Active.
  await expect(row(page, DISMISS_ADDRESS)).toHaveCount(0);
  // Absent from Saved.
  await selectBucket(page, "saved");
  await expect(row(page, DISMISS_ADDRESS)).toHaveCount(0);
  // Present in Dismissed (and the dismissed chip gained one).
  await selectBucket(page, "dismissed");
  await expect(row(page, DISMISS_ADDRESS)).toBeVisible();
  await expect
    .poll(() => bucketCount(page, "dismissed"))
    .toBe(dismissedBefore + 1);

  // Restore → the home comes back; it is still bookmarked (dismiss never touched
  // the save overlay), so it returns to BOTH Active and Saved.
  await row(page, DISMISS_ADDRESS).getByTestId("listing-restore").click();
  await expect(row(page, DISMISS_ADDRESS)).toHaveCount(0); // gone from Dismissed view
  await selectBucket(page, "active");
  await expect(row(page, DISMISS_ADDRESS)).toBeVisible();
  await selectBucket(page, "saved");
  await expect(row(page, DISMISS_ADDRESS)).toBeVisible();

  // Clean up the bookmark so the run leaves no overlay behind (afterAll also
  // sweeps it belt-and-braces).
  await row(page, DISMISS_ADDRESS).getByTestId("interest-button").click();
  await expect(row(page, DISMISS_ADDRESS)).toHaveCount(0); // gone from Saved view
});
