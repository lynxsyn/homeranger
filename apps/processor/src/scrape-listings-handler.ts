/**
 * scrape:listings consumer — runs the listing-site scrape pipeline. Two modes,
 * branched on the payload:
 *   - { site } (manual trigger): scrape THAT site over the explicit outcodes.
 *   - fieldless (no site): the scheduler-driven scan — runScheduledScrape()
 *     resolves the target outcodes from active operator searches + loops every
 *     ENABLED site (the scheduler has no DB).
 * Delegates to the ListingScrapeService. Scrape errors (transient 429/5xx) are
 * retryable via the shared worker-error mapper; config errors (missing key /
 * disabled site) are non-retryable (dropped). Scraping only SOURCES + links out.
 */
import type { ScrapeListingsJobPayload } from "@homeranger/backend-core/lib/queue/queue-config";
import {
  LISTING_SCRAPE_SITES,
  type ListingScrapeSite,
} from "@homeranger/backend-core/lib/listing-scrape/listing-scrape.provider";
import type { ListingScrapeService } from "@homeranger/backend-core/services/listing-scrape.service";
import { toWorkerError } from "./worker-error.js";

export interface ScrapeListingsHandlerDeps {
  listingScrapeService: ListingScrapeService;
}

function asSite(value: string): ListingScrapeSite | null {
  return (LISTING_SCRAPE_SITES as readonly string[]).includes(value)
    ? (value as ListingScrapeSite)
    : null;
}

export function makeScrapeListingsHandler(deps: ScrapeListingsHandlerDeps) {
  return async function handleScrapeListings(job: {
    data: ScrapeListingsJobPayload;
  }): Promise<void> {
    const { site, outcodes, regionLabel } = job.data;
    try {
      if (site) {
        const resolved = asSite(site);
        if (!resolved) {
          // An unknown site string is a config error — drop (non-retryable).
          throw Object.assign(new Error(`unknown scrape site: ${site}`), {
            retryable: false,
          });
        }
        if (!outcodes || outcodes.length === 0) {
          // A manual trigger with a site but no outcodes scrapes nothing (the
          // provider short-circuits on an empty patch). Surface it so a
          // misconfigured trigger is not a silent no-op.
          console.warn(
            JSON.stringify({
              type: "warn",
              scope: "scrape.listings.no_outcodes",
              site: resolved,
            }),
          );
        }
        await deps.listingScrapeService.runScrape({
          site: resolved,
          outcodes: outcodes ?? [],
          ...(regionLabel !== undefined ? { regionLabel } : {}),
        });
      } else {
        await deps.listingScrapeService.runScheduledScrape();
      }
    } catch (error) {
      throw toWorkerError(error, {
        scope: "scrape.listings.failed",
        ...(site ? { site } : {}),
      });
    }
  };
}
