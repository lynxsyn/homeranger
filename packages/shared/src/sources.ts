/**
 * Shared source catalogue — the SINGLE source of truth for the genuinely-wired
 * listing-scrape sources (PR #80/#81/#82), shared by BOTH the SPA and the
 * backend so the Sources table and the Listings "From" column never drift.
 *
 * `@homeranger/shared` is framework-free (zod only) and must NOT import from
 * `@homeranger/backend-core`, so the drift guard against the backend's
 * `LISTING_SCRAPE_SITES` lives in `sources.test.ts` as a literal-set assertion
 * pinning `lib/listing-scrape/listing-scrape.provider.ts` as source-of-truth.
 */
import { z } from "zod";
import type { ListingSource } from "./listing-enums.js";

export type SourceKind = "auction" | "land";

/** Static metadata for ONE crawled source. id MUST be a ListingSource enum member. */
export interface SourceCatalogueEntry {
  id: ListingSource; // "auctionhouse" | "uklandandfarms"
  name: string; // "Auction House"
  domain: string; // "auctionhouse.co.uk"  (no scheme)
  kind: SourceKind;
}

/**
 * The ONLY genuinely-wired scraper sources (PR #80/#81/#82). Ordered exactly as
 * the Sources table renders. NEVER add agent_email/manual here — they are not
 * crawled. Built to scale to N; ships exactly these 2.
 */
export const SOURCE_CATALOGUE: readonly SourceCatalogueEntry[] = [
  { id: "auctionhouse", name: "Auction House", domain: "auctionhouse.co.uk", kind: "auction" },
  { id: "uklandandfarms", name: "UK Land & Farms", domain: "uklandandfarms.co.uk", kind: "land" },
] as const;

/** id → display name, for the Listings From-column ("source name for scraped, agency for agent"). */
export const SOURCE_NAMES: Partial<Record<ListingSource, string>> =
  Object.fromEntries(SOURCE_CATALOGUE.map((s) => [s.id, s.name]));

/** Empty-strict input symmetry for sources.list (optional; the router needs no input). */
export const sourcesListInputSchema = z.object({}).strict();
export type SourcesListInput = z.infer<typeof sourcesListInputSchema>;
