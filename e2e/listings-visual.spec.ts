/**
 * Listings VISUAL / LAYOUT E2E — the guard the prior "table overflow" fix (#88)
 * lacked. That fix asserted only DOCUMENT-level horizontal overflow, which the
 * `.tablewrap` (overflow:hidden, back then) made trivially true: the table could
 * spill its own wrapper and collide its headers without widening the page. The
 * operator still saw a clipped, "MATCHFROM"-collided table.
 *
 * This suite measures the listings table + card view as a human sees them, across
 * the real spread of phone → QHD widths, in BOTH themes, and asserts the shared
 * layout invariants (see e2e/helpers/layout.ts): the page never scrolls
 * horizontally at any width; at desktop widths the table fits its card (measured
 * on the WRAPPER, the check #88 missed); no header collides; the action/source
 * cells never clip; rows stay compact; the thumbnail stays a 46px tile. At phone
 * widths the table may scroll inside its card — but the page never does.
 *
 * Auth: dev bypass (see playwright.config.ts). No login / storageState.
 */
import { expect, test } from "@playwright/test";
import { freezeAndReady, layoutViolations, useTheme } from "./helpers/layout";

const VIEWPORTS = [
  { w: 2560, h: 1440, label: "QHD monitor" },
  { w: 1920, h: 1080, label: "desktop monitor" },
  { w: 1536, h: 864, label: "scaled laptop" },
  { w: 1440, h: 900, label: "MacBook" },
  { w: 1366, h: 768, label: "common laptop" },
  { w: 1280, h: 800, label: "small laptop" },
  { w: 1100, h: 800, label: "split-screen / small laptop" },
  { w: 1024, h: 768, label: "iPad landscape" },
  { w: 912, h: 1000, label: "all-columns boundary" },
  { w: 768, h: 1024, label: "tablet portrait" },
  { w: 640, h: 900, label: "narrow / large phone landscape" },
] as const;
// Below ~640px is below this single-tenant desktop-operator tool's target range
// (a mobile app is a documented non-goal). The app chrome (topbar nav) is not
// phone-responsive, so the generic sweep stops at 640; the table's graceful
// degradation at true phone widths is guarded by the dedicated test at the end.

for (const vp of VIEWPORTS) {
  for (const theme of ["light", "dark"] as const) {
    test(`listings table fits cleanly at ${vp.w}x${vp.h} (${vp.label}) — ${theme}`, async ({
      page,
    }) => {
      await useTheme(page, theme);
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.goto("/listings");
      await expect(page.getByTestId("listings-table")).toBeVisible();
      await page.getByTestId("view-table").click();
      await freezeAndReady(page);
      const violations = await layoutViolations(page, vp.w);
      expect(violations, `Layout violations at ${vp.w}x${vp.h} (${theme}):\n  - ${violations.join("\n  - ")}`).toEqual([]);
    });
  }
}

// The card grid (tall-by-design 4:3 photos) must never push the page wide either.
for (const vp of [VIEWPORTS[1], VIEWPORTS[3], VIEWPORTS[6], VIEWPORTS[9], VIEWPORTS[10]]) {
  for (const theme of ["light", "dark"] as const) {
    test(`listings cards fit cleanly at ${vp.w}x${vp.h} (${vp.label}) — ${theme}`, async ({
      page,
    }) => {
      await useTheme(page, theme);
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.goto("/listings");
      await expect(page.getByTestId("listings-table")).toBeVisible();
      await page.getByTestId("view-cards").click();
      await expect(page.locator(".grid-cards")).toBeVisible();
      await freezeAndReady(page);
      const violations = await layoutViolations(page, vp.w);
      expect(violations, `Card violations at ${vp.w}x${vp.h} (${theme}):\n  - ${violations.join("\n  - ")}`).toEqual([]);
    });
  }
}

// Phone widths are below the operator-tool target range, but the table must still
// DEGRADE GRACEFULLY rather than reintroduce the clipped/collapsed bug: thanks to
// the table min-width + .tablewrap{overflow-x:auto}, an over-narrow viewport
// scrolls the table INSIDE its card (the address column keeps a usable width and
// nothing is clipped), instead of squeezing the address column to 0 and clipping
// it against the wrapper edge. (Guards the adversarial-review regression finding.)
test("listings table degrades gracefully on a phone — scrolls in its card, never collapses/clips", async ({
  page,
}) => {
  await useTheme(page, "light");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/listings");
  await expect(page.getByTestId("listings-table")).toBeVisible();
  await freezeAndReady(page);
  const r = await page.evaluate(() => {
    const table = document.querySelector<HTMLElement>('[data-testid="listings-table"]')!;
    const wrap = table.closest<HTMLElement>(".tablewrap")!;
    const addr = document.querySelector<HTMLElement>(".cell-addr b");
    return {
      cardScrolls: wrap.scrollWidth - wrap.clientWidth > 0,
      addrWidth: addr ? Math.round(addr.getBoundingClientRect().width) : 0,
      headerCollision: Array.from(table.querySelectorAll<HTMLElement>("thead th")).some(
        (th) => th.clientWidth > 0 && th.scrollWidth - th.clientWidth > 1,
      ),
      controlClip: Array.from(
        table.querySelectorAll<HTMLElement>("td.col-int, td.col-src"),
      ).some((td) => td.clientWidth > 0 && td.scrollWidth - td.clientWidth > 1),
    };
  });
  expect(r.cardScrolls, "the table card should absorb the overflow by scrolling (not clip the page)").toBe(true);
  expect(r.addrWidth, "the address column must stay usable, never collapsed").toBeGreaterThan(80);
  expect(r.headerCollision, "no header collision even when scrolling").toBe(false);
  expect(r.controlClip, "no action/source control clipped even when scrolling").toBe(false);
});
