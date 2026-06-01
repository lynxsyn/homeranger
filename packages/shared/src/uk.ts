/**
 * UK postal-geography constants + helpers shared FE/BE.
 *
 * Dependency-light by design (no zod import needed for the pure helpers; the
 * regex is exported so callers can build their own zod refinements). An
 * outcode is the first half of a UK postcode (e.g. `SW1A`, `EC1`, `M1`,
 * `B33`); the full postcode appends the inward code (`SW1A 1AA`).
 */

/**
 * Outcode (postcode area+district) pattern: 1 area letter, optional second
 * letter, 1–2 digits, optional trailing district letter (e.g. `W1A`, `EC1A`).
 * Case-insensitive; callers should upper-case via {@link normaliseOutcode}
 * before persisting. Anchored — use `.test()` on a single trimmed token.
 */
export const UK_OUTCODE_REGEX = /^[A-Z]{1,2}\d[A-Z\d]?$/i;

/**
 * Full UK postcode pattern (outcode + single space + inward code). The inward
 * code is always one digit followed by two letters (e.g. `SW1A 1AA`).
 * Case- and space-tolerant; normalise with {@link normalisePostcode}.
 */
export const UK_POSTCODE_REGEX = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

/** Max stored length of a normalised outcode (longest real outcode is 4). */
export const MAX_OUTCODE_LENGTH = 4;

/** Max stored length of a normalised postcode incl. the single space (8). */
export const MAX_POSTCODE_LENGTH = 8;

/**
 * Normalise a UK postcode to canonical form: trimmed, upper-cased, with a
 * single space separating the outward and inward codes (`sw1a1aa` →
 * `SW1A 1AA`). Returns `null` when the input is not a structurally valid UK
 * postcode so callers can branch on bad input rather than persist garbage.
 */
export function normalisePostcode(raw: string): string | null {
  const compact = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(compact)) return null;
  // The inward code is always the final 3 chars; everything before is outward.
  const inward = compact.slice(-3);
  const outward = compact.slice(0, -3);
  return `${outward} ${inward}`;
}

/**
 * Extract and normalise the outcode (outward half) from a full or partial UK
 * postcode/outcode. Accepts either a full postcode (`SW1A 1AA` → `SW1A`) or a
 * bare outcode (`sw1a` → `SW1A`). Returns `null` for input that is not a valid
 * outcode prefix.
 */
export function normaliseOutcode(raw: string): string | null {
  const compact = raw.replace(/\s+/g, "").toUpperCase();
  // If a full postcode was passed, strip the 3-char inward code first.
  const candidate = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(compact)
    ? compact.slice(0, -3)
    : compact;
  return UK_OUTCODE_REGEX.test(candidate) ? candidate : null;
}

/** True when `value` is a structurally valid UK outcode (any case). */
export function isValidOutcode(value: string): boolean {
  return UK_OUTCODE_REGEX.test(value.trim());
}
