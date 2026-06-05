/**
 * Listings VISUAL SNAPSHOTS — pixel baselines for the listings table (light +
 * dark) and the card grid, the surfaces the #88 fix regressed. They complement
 * the deterministic invariants in listings-visual.spec.ts: the invariants prove
 * the layout never overflows/stretches at any width; these prove the pixels
 * themselves still match the approved design
 * (docs/design/homeranger-design/project/screenshots/table-*.png).
 *
 * Determinism:
 *   - rows are sorted by ADDRESS (client-side, stable) so the order never
 *     depends on the server's tie-break among un-scored rows;
 *   - motion is frozen and dynamic regions are masked: the relative "Seen"
 *     times (wall-clock dependent) and the hotlinked source thumbnails (which
 *     may or may not load over the network in CI);
 *   - a small maxDiffPixelRatio (playwright.config.ts) absorbs anti-aliasing.
 *
 * Baselines are committed for chromium-LINUX only and MUST be regenerated in the
 * pinned Playwright Linux image so they match the ubuntu-latest CI runner — do
 * NOT `--update-snapshots` on macOS/Windows (that writes a -darwin/-win baseline
 * CI never reads). With the dev stack up and web bound to 0.0.0.0
 * (`VITE_E2E_AUTH_BYPASS=1 pnpm --filter @homeranger/web dev -- --host`):
 *
 *   docker run --rm --add-host=host.docker.internal:host-gateway \
 *     -v "$PWD/e2e:/w/e2e" -v "$PWD/playwright.config.ts:/w/playwright.config.ts" \
 *     -w /w -e PW_NO_WEBSERVER=1 -e E2E_BASE_URL=http://host.docker.internal:5173 \
 *     mcr.microsoft.com/playwright:v1.60.0-noble \
 *     bash -lc 'npm i -D @playwright/test@1.60.0 >/dev/null 2>&1 && \
 *       npx playwright test listings-snapshots.spec.ts --update-snapshots --reporter line'
 */
import { expect, test, type Page } from "@playwright/test";

async function prepare(page: Page, theme: "light" | "dark") {
  await page.goto("/listings");
  await expect(page.getByTestId("listings-table")).toBeVisible();
  await page.addStyleTag({
    content:
      "*,*::before,*::after{transition:none!important;animation:none!important;}",
  });
  await page.evaluate((t) => {
    localStorage.setItem("hs-theme", t);
    document.documentElement.setAttribute("data-theme", t);
  }, theme);
  // Deterministic row order, independent of the server's tie-break among the
  // un-scored seed rows.
  await page.getByTestId("sort-by").selectOption("address");
}

for (const theme of ["light", "dark"] as const) {
  test(`listings table matches the ${theme} design baseline @1440`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await prepare(page, theme);
    await page.getByTestId("view-table").click();
    const wrap = page.locator(".tablewrap");
    await expect(wrap).toBeVisible();
    await expect(wrap).toHaveScreenshot(`listings-table-${theme}-1440.png`, {
      // Mask the inherently data-dependent regions so the baseline is stable
      // across runs + machines: the hotlinked thumbnails (may not load in CI),
      // the relative "Seen" times (wall-clock), and the match-score rings (a
      // prior spec may have analysed a seed row). Column geometry — the thing
      // #88 broke — is still fully asserted around the masks.
      mask: [
        page.locator(".cell-addr .thumb"),
        page.locator(".seen-cell"),
        page.locator(".score-cell"),
      ],
    });
  });
}

test("listings cards match the light design baseline @1280", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await prepare(page, "light");
  await page.getByTestId("view-cards").click();
  const grid = page.locator(".grid-cards");
  await expect(grid).toBeVisible();
  await expect(grid).toHaveScreenshot("listings-cards-light-1280.png", {
    // Mask the photo tile (real image vs placeholder) and the whole score block
    // (ring fill + "Seen" time) — both data-/wall-clock-dependent.
    mask: [page.locator(".pcard-photo"), page.locator(".hs-score")],
  });
});
