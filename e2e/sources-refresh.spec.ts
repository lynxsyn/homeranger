/**
 * Sources "Refresh listings" E2E — the operator-only on-demand crawl trigger.
 *
 * The dev-bypass identity (CF_ACCESS_* unset → DEV_USER_EMAIL, which is the
 * configured operator) sees the operator-only Refresh control. Clicking it calls
 * sources.refresh, which enqueues a fieldless scrape:listings scan on the real
 * Redis (the Playwright webServer infra); the UI shows the queued confirmation.
 *
 * We assert the operator path end-to-end (control present → click → confirmation),
 * NOT that listings actually change — the scan is async and depends on
 * LISTING_SCRAPE_SITES + the live sites, which is out of scope for a deterministic
 * e2e (the unit + integration layers cover the enqueue; post-release verify
 * covers the live crawl).
 *
 * Auth: the api webServer runs with CF_ACCESS_* unset → dev bypass, so every tRPC
 * call is authenticated as the operator and the Refresh control renders.
 */
import { expect, test } from "@playwright/test";

// The sources controls row sits below a metrics strip; a desktop-height viewport
// keeps it reachable without a fragile scroll dance.
test.use({ viewport: { width: 1280, height: 1000 } });

test("operator can trigger an on-demand listings refresh from the Sources tab", async ({
  page,
}) => {
  await page.goto("/sources");
  await expect(page.getByTestId("sources-table")).toBeVisible();

  // The operator-only control renders for the dev-bypass operator identity.
  const refresh = page.getByTestId("sources-refresh");
  await expect(refresh).toBeVisible();
  await expect(refresh).toBeEnabled();

  // The control sits in a controls row that can scroll under the sticky topbar,
  // so invoke the React onClick directly (the documented sources/listings
  // workaround) rather than a center-point hit-test.
  await refresh.evaluate((el) => (el as HTMLElement).click());

  // The enqueue succeeds against the real api + Redis → the queued confirmation
  // renders (Playwright auto-waits through the brief pending state).
  const status = page.getByTestId("sources-refresh-status");
  await expect(status).toBeVisible();
  await expect(status).toContainText(/queued/i);
});
