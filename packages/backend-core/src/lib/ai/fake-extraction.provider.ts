/**
 * Env-gated FAKE listing extractor for E2E / integration / CI — implements the
 * `ListingExtractionProvider` interface WITHOUT calling Anthropic. It derives a
 * deterministic listing from the email subject/body so a Svix-signed
 * `email.received` POST drives a real Listing upsert end-to-end with no LLM
 * spend or network egress.
 *
 * Convention: the test harness puts a recognisable address + postcode in the
 * email subject (e.g. "New listing: 7 Test Road SW1A 1AA, £450,000"); this
 * extractor regex-parses the postcode + a price and uses the remaining subject
 * text as the raw address. Enabled by `EXTRACTION_FAKE=1`; never used in prod.
 */
import { UK_POSTCODE_REGEX } from "@homescout/shared";
import type {
  DecodedAttachment,
  ExtractedListing,
  ListingExtractionProvider,
} from "../../services/inbound-ingestion.service.js";

const POSTCODE_GLOBAL = /[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/gi;
const PRICE_POUNDS = /£\s*([\d,]+)/;

export class FakeListingExtractionProvider implements ListingExtractionProvider {
  async extract(input: {
    bodyText: string | null;
    bodyHtml: string | null;
    subject: string | null;
    fromAddress?: string | null;
    attachments: DecodedAttachment[];
  }): Promise<ExtractedListing> {
    const haystack = [input.subject, input.bodyText]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join("\n");

    const postcodeMatch = haystack.match(POSTCODE_GLOBAL);
    const postcode =
      postcodeMatch && UK_POSTCODE_REGEX.test(postcodeMatch[0])
        ? postcodeMatch[0]
        : null;

    const priceMatch = haystack.match(PRICE_POUNDS);
    const pricePence = priceMatch
      ? Number.parseInt(priceMatch[1]!.replaceAll(",", ""), 10) * 100
      : null;

    // Address = the subject with the "New listing:" prefix + trailing price
    // stripped, falling back to the subject verbatim.
    const addressRaw =
      (input.subject ?? "")
        .replace(/^new listing:\s*/i, "")
        .replace(PRICE_POUNDS, "")
        .replace(/,\s*$/, "")
        .trim() || null;

    return {
      addressRaw,
      postcode,
      outcode: null,
      pricePence,
      bedrooms: null,
      bathrooms: null,
      tenure: null,
      propertyType: null,
      epcRating: null,
      listingStatus: "pre_market",
      listingUrl: null,
      confidence: 0.9,
    };
  }
}
