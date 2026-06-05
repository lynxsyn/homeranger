/**
 * ALL-PAGES VISUAL / LAYOUT E2E — the generic guard that every authenticated
 * page renders cleanly (no horizontal page scroll, no clipped table column, no
 * collapsed/stretched row) across phone → monitor widths in BOTH themes.
 * listings-visual.spec.ts covers Listings in depth (table + cards); this sweep
 * covers Agents, Sources, Searches and Settings — so a too-narrow fixed column
 * (e.g. the Agents kebab that was clipped against the table edge) or a wide form
 * row can never ship a janky page again.
 *
 * Invariants live in e2e/helpers/layout.ts. Auth: dev bypass. The E2E seed gives
 * every page a populated table/list (8 listings, 4 agents, 3 source records, 1
 * search) so the geometry is real, not an empty state.
 */
import { expect, test } from "@playwright/test";
import { freezeAndReady, layoutViolations, useTheme } from "./helpers/layout";

/** Each page + a locator proving its main content rendered. */
const PAGES = [
  { path: "/agents", ready: "table.agents-table" },
  { path: "/sources", ready: '[data-testid="sources-table"]' },
  { path: "/searches", ready: '[data-testid="search-card"]' },
  { path: "/settings", ready: '[data-testid="settings-page"]' },
] as const;

const VIEWPORTS = [
  { w: 1920, h: 1080, label: "desktop monitor" },
  { w: 1440, h: 900, label: "MacBook" },
  { w: 1280, h: 800, label: "small laptop" },
  { w: 1024, h: 768, label: "iPad landscape" },
  { w: 912, h: 1000, label: "all-columns boundary" },
  { w: 768, h: 1024, label: "tablet portrait" },
] as const;
// 768 is the floor of this desktop-operator tool's target range; the app chrome
// (topbar nav) is not phone-responsive (a mobile app is a documented non-goal),
// so the generic page sweep stops here. The tables' graceful degradation below
// 768 is covered by the dedicated phone test in listings-visual.spec.ts.

for (const pg of PAGES) {
  for (const vp of VIEWPORTS) {
    for (const theme of ["light", "dark"] as const) {
      test(`${pg.path} fits cleanly at ${vp.w}x${vp.h} (${vp.label}) — ${theme}`, async ({
        page,
      }) => {
        await useTheme(page, theme);
        await page.setViewportSize({ width: vp.w, height: vp.h });
        await page.goto(pg.path);
        await page.locator(pg.ready).first().waitFor({ state: "visible" });
        await freezeAndReady(page);
        const violations = await layoutViolations(page, vp.w);
        expect(
          violations,
          `Layout violations on ${pg.path} at ${vp.w}x${vp.h} (${theme}):\n  - ${violations.join("\n  - ")}`,
        ).toEqual([]);
      });
    }
  }
}
