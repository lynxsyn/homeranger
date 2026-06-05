/**
 * VISUAL SNAPSHOTS — committed pixel baselines for the table/list surfaces of
 * every authenticated page (listings table + cards, agents, sources, searches),
 * the supplement to the deterministic invariants in *-visual.spec.ts. The
 * invariants prove the layout never overflows/stretches at any width; these prove
 * the pixels themselves don't drift (spacing, colour, alignment) from the
 * approved look — including the surfaces this PR fixed (the listings table and
 * the agents kebab column). (Settings is deterministically covered but not
 * pixel-snapshotted — see the note by that page below.)
 *
 * Determinism:
 *   - theme is set via the pre-paint script BEFORE load (helpers/useTheme), and
 *     web fonts are awaited (helpers/freezeAndReady), so renders are stable;
 *   - listings rows are sorted by ADDRESS (stable); agents/sources/searches use
 *     their repositories' deterministic orderBy over the fixed E2E seed;
 *   - data-/wall-clock-dependent regions are masked: thumbnails + photos, the
 *     relative "Seen"/"Last contact"/"Latest"/stats times, and the match-score
 *     rings (a prior spec may analyse a seed row). Column geometry — what this
 *     PR fixes — is asserted AROUND the masks; a small maxDiffPixelRatio
 *     (playwright.config.ts) absorbs anti-aliasing.
 *
 * Baselines are committed for BOTH chromium-linux (the ubuntu-latest CI runner,
 * generated in the pinned mcr.microsoft.com/playwright:v1.60.0-noble image) and
 * chromium-darwin (local dev on macOS), so `pnpm test:e2e` passes on both. Do NOT
 * `--update-snapshots` on a third platform without generating its baseline. The
 * linux regen command (dev stack up, web reachable):
 *
 *   docker run --rm --add-host=host.docker.internal:host-gateway \
 *     -v "$PWD/e2e:/w/e2e" -v "$PWD/playwright.config.ts:/w/playwright.config.ts" \
 *     -w /w -e PW_NO_WEBSERVER=1 \
 *     mcr.microsoft.com/playwright:v1.60.0-noble bash -lc '
 *       IP=$(getent ahostsv4 host.docker.internal | awk "{print \$1}" | head -1)
 *       E2E_BASE_URL=http://$IP:5173 npm i -D @playwright/test@1.60.0 >/dev/null 2>&1
 *       E2E_BASE_URL=http://$IP:5173 npx playwright test pages-snapshots.spec.ts --update-snapshots'
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { freezeAndReady, useTheme } from "./helpers/layout";

async function open(
  page: Page,
  path: string,
  theme: "light" | "dark",
  ready: string,
) {
  await useTheme(page, theme);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(path);
  await page.locator(ready).first().waitFor({ state: "visible" });
  await freezeAndReady(page);
}

const listingsMasks = (page: Page): Locator[] => [
  page.locator(".cell-addr .thumb"),
  page.locator(".seen-cell"),
  page.locator(".score-cell"),
];

for (const theme of ["light", "dark"] as const) {
  test(`listings table — ${theme}`, async ({ page }) => {
    await open(page, "/listings", theme, '[data-testid="listings-table"]');
    await page.getByTestId("view-table").click();
    await page.getByTestId("sort-by").selectOption("address");
    await expect(page.locator(".tablewrap")).toHaveScreenshot(
      `listings-table-${theme}.png`,
      { mask: listingsMasks(page) },
    );
  });
}

test("listings cards — light", async ({ page }) => {
  await open(page, "/listings", "light", '[data-testid="listings-table"]');
  await page.getByTestId("view-cards").click();
  await page.getByTestId("sort-by").selectOption("address");
  await expect(page.locator(".grid-cards")).toHaveScreenshot(
    "listings-cards-light.png",
    { mask: [page.locator(".pcard-photo"), page.locator(".hs-score")] },
  );
});

for (const theme of ["light", "dark"] as const) {
  test(`agents table — ${theme}`, async ({ page }) => {
    await open(page, "/agents", theme, "table.agents-table");
    await expect(page.locator(".tablewrap")).toHaveScreenshot(
      `agents-table-${theme}.png`,
      { mask: [page.locator(".col-seen")] },
    );
  });
}

test("sources table — light", async ({ page }) => {
  await open(page, "/sources", "light", '[data-testid="sources-table"]');
  await expect(page.locator(".tablewrap")).toHaveScreenshot("sources-table-light.png", {
    mask: [page.locator(".col-seen")],
  });
});

test("searches — light", async ({ page }) => {
  await open(page, "/searches", "light", '[data-testid="search-card"]');
  await expect(page.locator("main")).toHaveScreenshot("searches-light.png", {
    mask: [page.locator('[data-testid="search-stats"]')],
  });
});

// NB: the Settings page is intentionally NOT pixel-snapshotted. Its rendered
// HEIGHT depends on the operator's SearchProfile (name / phone / signature /
// urgency line), which a sibling spec (account-menu) legitimately mutates +
// resets, so a full-page baseline is data-dependent and brittle (the element's
// size itself shifts, which masking cannot absorb). Settings layout / no-overflow
// IS guarded — deterministically, across every width × theme — by
// pages-visual.spec.ts.
