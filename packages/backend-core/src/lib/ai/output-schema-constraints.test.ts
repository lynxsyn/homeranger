/**
 * Regression guard for the Anthropic structured-output (`output_config.format =
 * { type: "json_schema", schema }`) constraint that bit prod (analyze:listing
 * 400, scope analyze.dropped.non_retryable):
 *
 *   output_config.format.schema: For 'number' type, properties maximum, minimum
 *   are not supported
 *
 * The Anthropic structured-output JSON schema does NOT support `minimum` /
 * `maximum` on `number`/`integer` fields (nor, to be safe, the other numeric
 * keyword constraints). Any schema we send via `output_config.format.schema`
 * must therefore carry NO such bounds — the range belongs in the field
 * `description` (to guide the model) and the value is clamped in code on parse.
 *
 * This walks every schema we hand to Anthropic and asserts no numeric field
 * carries a bound, so re-introducing one fails here instead of in prod.
 */
import { describe, expect, it } from "vitest";
import { LISTING_EXTRACTION_SCHEMA } from "./claude-extraction.provider.js";
import { MATCH_SCORE_SCHEMA } from "./match-scorer.provider.js";
import { PHOTO_SCORE_SCHEMA } from "./vision-scorer.provider.js";

/** JSON-schema keywords Anthropic structured output rejects on numeric types. */
const UNSUPPORTED_NUMERIC_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
] as const;

/** Paths (dotted) of every numeric field carrying an unsupported bound keyword. */
function numericFieldsWithBounds(schema: unknown, path = "$"): string[] {
  if (schema === null || typeof schema !== "object") {
    return [];
  }
  const s = schema as Record<string, unknown>;
  const hits: string[] = [];

  const type = s.type;
  const isNumeric =
    type === "number" ||
    type === "integer" ||
    (Array.isArray(type) &&
      type.some((t) => t === "number" || t === "integer"));
  if (isNumeric && UNSUPPORTED_NUMERIC_KEYWORDS.some((k) => k in s)) {
    hits.push(path);
  }

  if (s.properties && typeof s.properties === "object") {
    for (const [key, value] of Object.entries(
      s.properties as Record<string, unknown>,
    )) {
      hits.push(...numericFieldsWithBounds(value, `${path}.${key}`));
    }
  }
  if (s.items) {
    hits.push(...numericFieldsWithBounds(s.items, `${path}[]`));
  }
  return hits;
}

describe("Anthropic structured-output schemas carry no numeric bounds", () => {
  // The helper itself catches a bound (so a green run can't be a false negative).
  it("the bound-detector flags a numeric field with minimum/maximum", () => {
    expect(
      numericFieldsWithBounds({
        type: "object",
        properties: { n: { type: "number", minimum: 0, maximum: 1 } },
      }),
    ).toEqual(["$.n"]);
  });

  it("MATCH_SCORE_SCHEMA has no minimum/maximum on numeric fields", () => {
    expect(numericFieldsWithBounds(MATCH_SCORE_SCHEMA)).toEqual([]);
  });

  it("PHOTO_SCORE_SCHEMA has no minimum/maximum on numeric fields", () => {
    expect(numericFieldsWithBounds(PHOTO_SCORE_SCHEMA)).toEqual([]);
  });

  it("LISTING_EXTRACTION_SCHEMA has no minimum/maximum on numeric fields", () => {
    // The third schema we hand to Anthropic (claude-extraction). Clean today —
    // guarded here so a future numeric bound on price/beds/baths/confidence
    // fails in CI, not in prod.
    expect(numericFieldsWithBounds(LISTING_EXTRACTION_SCHEMA)).toEqual([]);
  });
});
