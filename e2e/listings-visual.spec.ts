/**
 * Listings VISUAL / LAYOUT E2E — the guard that the prior "table overflow" fix
 * (#88) lacked. That fix asserted only DOCUMENT-level horizontal overflow, which
 * `.tablewrap { overflow: hidden }` makes trivially true: the table can spill its
 * own wrapper (clipped right edge) and collide its headers without ever widening
 * the document. The operator still saw a clipped, "MATCHFROM"-collided table.
 *
 * This suite measures the table the way a human sees it, across the real spread
 * of laptop + monitor widths, in BOTH themes and BOTH views, and asserts the
 * intention-aware invariants:
 *
 *   1. the page never scrolls horizontally (document fits the viewport);
 *   2. the table never spills its own wrapper (table.scrollWidth ≤ clientWidth) —
 *      the check #88 missed, since overflow:hidden hides it from the document;
 *   3. no column HEADER overflows its cell (a too-narrow fixed column makes the
 *      uppercase label spill into the next column — the "MATCHFROM" collision);
 *   4. the fixed-control cells (the row-action buttons + the source icon) are
 *      never clipped — these hold fixed-size controls, not truncatable text;
 *   5. rows stay COMPACT (≤ the design's ~73px, never vertically stretched);
 *   6. the address thumbnail is always its 46px tile, never blown up by a real
 *      hotlinked source image (the seed carries real auction/land image URLs).
 *
 * Truncatable text cells (address, agency) are deliberately NOT asserted to fit:
 * ellipsis truncation legitimately leaves scrollWidth > clientWidth WITHIN the
 * cell, and that is clipped by the cell, not spilled past the table — invariant
 * #2 already proves the table as a whole holds.
 *
 * Auth: dev bypass (CF_ACCESS_* unset, VITE_E2E_AUTH_BYPASS=1) — see
 * playwright.config.ts. No login / storageState.
 */
import { expect, test, type Page } from "@playwright/test";

/** The real laptop + monitor widths a UK desktop operator actually uses, plus
 *  the responsive boundaries where columns drop out (≤900 hides From/Seen,
 *  ≤680 hides Beds). Each must render a clean, non-overflowing table. */
const VIEWPORTS = [
  { w: 2560, h: 1440, label: "QHD monitor" },
  { w: 1920, h: 1080, label: "desktop monitor" },
  { w: 1536, h: 864, label: "scaled laptop" },
  { w: 1440, h: 900, label: "MacBook" },
  { w: 1366, h: 768, label: "common laptop" },
  { w: 1280, h: 800, label: "small laptop" },
  { w: 1100, h: 800, label: "split-screen / small laptop" },
  { w: 1024, h: 768, label: "iPad landscape" },
  { w: 912, h: 1000, label: "all-columns boundary (just above 900)" },
  { w: 768, h: 1024, label: "tablet portrait" },
  { w: 640, h: 900, label: "narrow / large phone" },
] as const;

const ROW_MAX_HEIGHT = 84; // design rows are 73px; allow a little cross-platform font slack
const ROW_MIN_HEIGHT = 50; // a collapsed row would fall below this
const THUMB_MAX = 48; // the address thumbnail tile is 46px (40px on ≤680)

/** Kill transitions/animations so layout measurement is deterministic. */
async function freezeMotion(page: Page) {
  await page.addStyleTag({
    content:
      "*,*::before,*::after{transition:none!important;animation:none!important;}",
  });
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((t) => {
    localStorage.setItem("hs-theme", t);
    document.documentElement.setAttribute("data-theme", t);
  }, theme);
}

/** Run all table-layout invariants in-page; returns a list of human-readable
 *  violations (empty = clean). Measuring in one evaluate keeps it fast + atomic. */
async function tableViolations(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ ROW_MAX_HEIGHT, ROW_MIN_HEIGHT, THUMB_MAX }) => {
      const v: string[] = [];
      const docEl = document.documentElement;
      const docOver = docEl.scrollWidth - docEl.clientWidth;
      if (docOver > 1) v.push(`document scrolls horizontally by ${docOver}px`);

      const table = document.querySelector<HTMLElement>(
        '[data-testid="listings-table"]',
      );
      if (!table) {
        v.push("listings table not found");
        return v;
      }
      const tableOver = table.scrollWidth - table.clientWidth;
      if (tableOver > 1)
        v.push(`table content spills its wrapper by ${tableOver}px (clipped right edge)`);

      // No HEADER may overflow its column (headers do not truncate).
      for (const th of Array.from(table.querySelectorAll<HTMLElement>("thead th"))) {
        const over = th.scrollWidth - th.clientWidth;
        if (th.clientWidth > 0 && over > 1) {
          const label = (th.textContent || th.getAttribute("aria-label") || "?").trim();
          v.push(`header "${label}" overflows its column by ${over}px (collision)`);
        }
      }

      // Fixed-control cells (row actions + source icon) must never clip.
      for (const sel of ["td.col-int", "td.col-src"]) {
        for (const td of Array.from(table.querySelectorAll<HTMLElement>(sel))) {
          const over = td.scrollWidth - td.clientWidth;
          if (td.clientWidth > 0 && over > 1) {
            v.push(`${sel} clips its control by ${over}px`);
            break; // one example per column is enough
          }
        }
      }

      // Rows stay compact (never vertically stretched), thumbs stay tiles.
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="listing-row"]'),
      );
      for (const r of rows) {
        const hgt = Math.round(r.getBoundingClientRect().height);
        if (hgt > ROW_MAX_HEIGHT)
          v.push(`row "${r.getAttribute("data-address")}" is ${hgt}px tall (> ${ROW_MAX_HEIGHT}px — stretched)`);
        if (hgt < ROW_MIN_HEIGHT)
          v.push(`row "${r.getAttribute("data-address")}" is only ${hgt}px tall (collapsed)`);
      }
      for (const thumb of Array.from(
        document.querySelectorAll<HTMLElement>(".cell-addr .thumb"),
      )) {
        const rect = thumb.getBoundingClientRect();
        if (rect.width > THUMB_MAX || rect.height > THUMB_MAX)
          v.push(`thumbnail is ${Math.round(rect.width)}x${Math.round(rect.height)}px (> ${THUMB_MAX}px — blown up by a real image)`);
      }
      return v;
    },
    { ROW_MAX_HEIGHT, ROW_MIN_HEIGHT, THUMB_MAX },
  );
}

/** In CARD view, no card may push the page wide or spill its column. */
async function cardViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const v: string[] = [];
    const docEl = document.documentElement;
    const docOver = docEl.scrollWidth - docEl.clientWidth;
    if (docOver > 1) v.push(`document scrolls horizontally by ${docOver}px (cards)`);
    const grid = document.querySelector<HTMLElement>(".grid-cards");
    if (!grid) {
      v.push("card grid not found");
      return v;
    }
    const gridRight = grid.getBoundingClientRect().right;
    for (const card of Array.from(
      document.querySelectorAll<HTMLElement>(".grid-cards .pcard"),
    )) {
      const r = card.getBoundingClientRect();
      if (r.right - gridRight > 1)
        v.push(`a card spills the grid by ${Math.round(r.right - gridRight)}px`);
      if (card.scrollWidth - card.clientWidth > 1)
        v.push(`a card's content spills horizontally by ${card.scrollWidth - card.clientWidth}px`);
    }
    return v;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/listings");
  await expect(page.getByTestId("listings-table")).toBeVisible();
  await freezeMotion(page);
});

for (const vp of VIEWPORTS) {
  for (const theme of ["light", "dark"] as const) {
    test(`table fits cleanly at ${vp.w}x${vp.h} (${vp.label}) — ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await setTheme(page, theme);
      await page.getByTestId("view-table").click();
      await expect(page.getByTestId("listings-table")).toBeVisible();
      const violations = await tableViolations(page);
      expect(violations, `Layout violations at ${vp.w}x${vp.h} (${theme}):\n  - ${violations.join("\n  - ")}`).toEqual([]);
    });
  }
}

// Cards are tall-by-design (4:3 photos); assert they never overflow horizontally
// across the spread, in both themes.
for (const vp of [VIEWPORTS[1], VIEWPORTS[3], VIEWPORTS[6], VIEWPORTS[9]]) {
  for (const theme of ["light", "dark"] as const) {
    test(`cards fit cleanly at ${vp.w}x${vp.h} (${vp.label}) — ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await setTheme(page, theme);
      await page.getByTestId("view-cards").click();
      await expect(page.locator(".grid-cards")).toBeVisible();
      const violations = await cardViolations(page);
      expect(violations, `Card violations at ${vp.w}x${vp.h} (${theme}):\n  - ${violations.join("\n  - ")}`).toEqual([]);
    });
  }
}
