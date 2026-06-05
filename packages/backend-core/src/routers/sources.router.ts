/**
 * sourcesRouter — the inbound/scheduled SIBLING of agentsRouter. A read-only,
 * derived-only view of the genuinely-wired listing-scrape sources (PR #80/#81/#82).
 *
 * VISIBILITY: protectedProcedure (any authenticated user). Sources are a GLOBAL
 * catalogue with NO per-user/PII data — unlike agents (operatorProcedure).
 *
 * Telemetry is DERIVED FROM REAL DATA ONLY (no guesswork): lotsFound =
 * COUNT(ListingSourceRecord), latestObservedAt = MAX(observedAt), coverage from
 * REGION_TAXONOMY. NO health dot, NO sale-date countdown, NO price cap.
 *
 * ONE builder over the fixed SOURCE_CATALOGUE (2 rows), joining two batch groupBy
 * queries via Promise.all — mirrors agentsRouter.buildAgentRows.
 */
import { SOURCE_CATALOGUE, type SourceKind } from "@homeranger/shared";
import type { ListingSource } from "@prisma/client";
import { protectedProcedure, router } from "../trpc.js";
import { listingSourceRecordRepository } from "../repositories/listing-source-record.repository.js";
import { siteCoverage } from "../lib/listing-scrape/listing-search.js";

export interface SourceRow {
  id: ListingSource;
  name: string;
  kind: SourceKind;
  domain: string;
  coverageOutcodes: string[];
  coverageLabel: string;
  lotsFound: number;
  latestObservedAt: Date | null;
}

/**
 * Title-case the first region alias as the single human coverage label. Exported
 * so the empty-alias branch ("" when a source maps no labelled region) is unit-
 * covered directly — both catalogue sources currently map the North-Wales row, so
 * the router path never yields an empty alias list.
 */
export function toCoverageLabel(aliases: string[]): string {
  const first = aliases[0];
  if (!first) return "";
  return first.replace(/\b\w/g, (c) => c.toUpperCase());
}

export const sourcesRouter = router({
  list: protectedProcedure.query(async (): Promise<SourceRow[]> => {
    const [countBySource, latestBySource] = await Promise.all([
      listingSourceRecordRepository.countBySourceType(),
      listingSourceRecordRepository.latestObservedBySourceType(),
    ]);
    return SOURCE_CATALOGUE.map((entry) => {
      // entry.id is "auctionhouse" | "uklandandfarms" — both are ListingScrapeSite members.
      const cov = siteCoverage(entry.id as Parameters<typeof siteCoverage>[0]);
      return {
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        domain: entry.domain,
        coverageOutcodes: cov.outcodes,
        coverageLabel: toCoverageLabel(cov.regionLabels),
        lotsFound: countBySource.get(entry.id) ?? 0,
        latestObservedAt: latestBySource.get(entry.id) ?? null,
      };
    });
  }),
});
