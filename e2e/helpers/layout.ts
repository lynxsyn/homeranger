/**
 * Shared layout-assertion helpers for the visual E2E suites
 * (listings-visual.spec.ts + pages-visual.spec.ts).
 *
 * The invariants encode the bug class these suites guard against — a table
 * column sized too small for its content spilling its `.tablewrap`, which
 * (because the wrapper clips/scrolls) shows as a clipped right edge, a header
 * colliding with the next column, or a collapsed flexible column:
 *
 *   - the PAGE never scrolls horizontally, at EVERY width (the user-facing
 *     symptom: "it overflows off to the right"). The tables scroll INSIDE their
 *     card on a too-narrow viewport, so the document itself never overflows;
 *   - at/above FIT_FLOOR (the operator's real laptop/monitor widths) every
 *     table FITS its wrapper with no internal scroll — measured on the WRAPPER
 *     (wrap.scrollWidth − wrap.clientWidth), because a table-layout:fixed table
 *     forced wider than its wrapper has table.scrollWidth === table.clientWidth
 *     and would hide the spill from a table-relative measurement;
 *   - no column HEADER overflows its cell (the "MATCHFROM" collision);
 *   - the fixed-control cells (.col-act / .col-src / .col-int) are never clipped;
 *   - rows stay compact (never vertically stretched);
 *   - the listings thumbnail stays its tile (never blown up by a real image).
 *
 * Truncatable text cells (address, agency, source name) are deliberately exempt:
 * ellipsis truncation legitimately leaves a cell's scrollWidth > clientWidth,
 * and that is clipped within the cell, not spilled past the table.
 */
import { type Page } from "@playwright/test";

/** At/above this viewport width every table must fit its wrapper with no
 *  horizontal scroll. Below it (tablet portrait / phone) the table may scroll
 *  inside its card — the page still must not scroll. Covers every real desktop
 *  + laptop + iPad-landscape width this single-tenant operator tool targets. */
export const FIT_FLOOR = 1024;
const ROW_MAX_HEIGHT = 100;
const THUMB_MAX = 48;

/** Set the persisted theme BEFORE the SPA loads, so the index.html pre-paint
 *  script applies it on first paint and no later React render can clobber it.
 *  Must be called before page.goto(). */
export async function useTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("hs-theme", t);
    } catch {
      /* storage may be unavailable pre-navigation; the goto retries it */
    }
  }, theme);
}

/** Freeze motion + wait for web fonts so width measurements are deterministic
 *  (a fallback font renders wider and yields phantom sub-pixel spills). */
export async function freezeAndReady(page: Page) {
  await page.addStyleTag({
    content:
      "*,*::before,*::after{transition:none!important;animation:none!important;}",
  });
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });
}

/** Run every layout invariant in-page; returns human-readable violations. */
export async function layoutViolations(
  page: Page,
  viewportWidth: number,
): Promise<string[]> {
  return page.evaluate(
    ({ vw, FIT_FLOOR, ROW_MAX_HEIGHT, THUMB_MAX }) => {
      const v: string[] = [];
      const docEl = document.documentElement;
      const docOver = docEl.scrollWidth - docEl.clientWidth;
      if (docOver > 1) {
        const pokers = Array.from(document.querySelectorAll<HTMLElement>("body *"))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.right > docEl.clientWidth + 1;
          })
          .slice(0, 4)
          .map((el) => `${el.tagName.toLowerCase()}.${(el.className || "").toString().trim().split(/\s+/).join(".").slice(0, 36)} (+${Math.round(el.getBoundingClientRect().right - docEl.clientWidth)}px)`);
        v.push(`document scrolls horizontally by ${docOver}px — offenders: ${pokers.join(", ") || "n/a"}`);
      }

      for (const table of Array.from(document.querySelectorAll<HTMLElement>("table"))) {
        if (table.clientWidth === 0) continue;
        const wrap = table.closest<HTMLElement>(".tablewrap");
        // At desktop widths the card must not scroll/clip: measure the WRAPPER.
        if (wrap && vw >= FIT_FLOOR) {
          const wrapSpill = wrap.scrollWidth - wrap.clientWidth;
          if (wrapSpill > 1)
            v.push(`a ${table.className} table overflows its card by ${wrapSpill}px at ${vw}px wide`);
        }
        for (const th of Array.from(table.querySelectorAll<HTMLElement>("thead th"))) {
          if (th.clientWidth > 0 && th.scrollWidth - th.clientWidth > 1) {
            const label = (th.textContent || th.getAttribute("aria-label") || "?").trim();
            v.push(`header "${label}" overflows its column by ${th.scrollWidth - th.clientWidth}px`);
          }
        }
        for (const sel of ["td.col-act", "td.col-src", "td.col-int"]) {
          for (const td of Array.from(table.querySelectorAll<HTMLElement>(sel))) {
            if (td.clientWidth > 0 && td.scrollWidth - td.clientWidth > 1) {
              v.push(`${sel} clips its control by ${td.scrollWidth - td.clientWidth}px`);
              break;
            }
          }
        }
        for (const row of Array.from(table.querySelectorAll<HTMLElement>("tbody tr"))) {
          const hgt = Math.round(row.getBoundingClientRect().height);
          if (hgt > ROW_MAX_HEIGHT)
            v.push(`a ${table.className} row is ${hgt}px tall (> ${ROW_MAX_HEIGHT}px — stretched)`);
        }
      }

      for (const thumb of Array.from(document.querySelectorAll<HTMLElement>(".cell-addr .thumb"))) {
        const rect = thumb.getBoundingClientRect();
        if (rect.width > THUMB_MAX || rect.height > THUMB_MAX)
          v.push(`a thumbnail is ${Math.round(rect.width)}x${Math.round(rect.height)}px (> ${THUMB_MAX}px — blown up by a real image)`);
      }
      return v;
    },
    { vw: viewportWidth, FIT_FLOOR, ROW_MAX_HEIGHT, THUMB_MAX },
  );
}
