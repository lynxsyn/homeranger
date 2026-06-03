/**
 * Display formatters for the listings UI. Pure functions (an injectable `now`
 * keeps `relativeTime`/`ageHoursSince` deterministic in tests).
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import type { PropertyType } from "@homeranger/shared";

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});

/** Format a price in whole pounds as `£625,000`; `null` → an em dash. */
export function gbp(pounds: number | null): string {
  if (pounds == null) {
    return "—";
  }
  return GBP.format(pounds);
}

/** Pence → whole pounds for display + sorting; `null` stays `null`. */
export function penceToPounds(pricePence: number | null): number | null {
  return pricePence == null ? null : Math.round(pricePence / 100);
}

/**
 * Humanise a PropertyType enum value for display: `semi_detached` →
 * `Semi-detached`, `terraced` → `Terraced`. `unknown`/`null` → `null` (the
 * caller omits the segment).
 */
export function humanizePropertyType(type: PropertyType | null): string | null {
  if (!type || type === "unknown") {
    return null;
  }
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, "-");
}

/** Whole hours since `value` — the numeric sort key behind "Seen". */
export function ageHoursSince(value: Date | string, now: Date = new Date()): number {
  const then = value instanceof Date ? value : new Date(value);
  return Math.max(0, (now.getTime() - then.getTime()) / 3_600_000);
}

/** Compact relative time: `just now` · `5m ago` · `2h ago` · `3d ago` · `2w ago` · `4mo ago` · `1y ago`. */
export function relativeTime(value: Date | string, now: Date = new Date()): string {
  const then = value instanceof Date ? value : new Date(value);
  const mins = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (mins < 1) {
    return "just now";
  }
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return `${weeks}w ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months}mo ago`;
  }
  return `${Math.floor(days / 365)}y ago`;
}
