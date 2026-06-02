/**
 * ListingsPage — hand-rolled accessible listings table (M3).
 *
 * Mirrors doxus .../OverviewFailuresTable.tsx: a semantic <table>, every
 * <th scope="col">, an aria-busy region, and loading/empty/error states.
 * Rows are typed via `inferRouterOutputs<AppRouter>["listings"]["list"]
 * ["items"][number]` so the table tracks the router output exactly (no
 * hand-written row interface).
 *
 * Filter controls (outcode, max price in POUNDS → pence, min beds) + a sort
 * selector drive the `@trpc/react-query` query. The source cell is an
 * `<a target="_blank" rel="noreferrer">` ONLY when `listingUrl` is non-null;
 * otherwise a non-link placeholder (AC#4 — no broken link). Each row carries a
 * row-expand toggle (aria-expanded / aria-controls) revealing an M5 placeholder.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@homescout/backend-core";
import {
  LISTING_SORT_FIELDS,
  type ListingSortField,
  type ListingStatus,
} from "@homescout/shared";
import { trpc } from "../lib/trpc";

type ListingRow =
  inferRouterOutputs<AppRouter>["listings"]["list"]["items"][number];

const SORT_LABELS: Record<ListingSortField, string> = {
  combinedScore: "Match score",
  price: "Price",
  lastSeenAt: "Last seen",
};

const STATUS_LABELS: Record<ListingStatus, string> = {
  pre_market: "Pre-market",
  live: "Live",
  under_offer: "Under offer",
  sold: "Sold",
  withdrawn: "Withdrawn",
};

function formatPrice(pricePence: number | null): string {
  if (pricePence === null) {
    return "—";
  }
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(pricePence / 100);
}

function formatBeds(bedrooms: number | null): string {
  return bedrooms === null ? "—" : String(bedrooms);
}

const COLUMN_COUNT = 7;

export function ListingsPage() {
  const [outcode, setOutcode] = useState("");
  const [maxPricePounds, setMaxPricePounds] = useState("");
  const [minBeds, setMinBeds] = useState("");
  const [sortBy, setSortBy] = useState<ListingSortField>("combinedScore");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Build the strict shared filter — omit fields entirely when empty so the
  // `.strict()` schema never sees a stray/empty key. maxPrice is entered in
  // POUNDS and converted to integer pence end-to-end.
  const filter = useMemo(() => {
    const f: {
      outcodes?: string[];
      maxPricePence?: number;
      minBedrooms?: number;
    } = {};
    const trimmedOutcode = outcode.trim().toUpperCase();
    if (trimmedOutcode) {
      f.outcodes = [trimmedOutcode];
    }
    const pounds = Number(maxPricePounds);
    if (maxPricePounds.trim() && Number.isFinite(pounds) && pounds >= 0) {
      f.maxPricePence = Math.round(pounds * 100);
    }
    const beds = Number(minBeds);
    if (minBeds.trim() && Number.isInteger(beds) && beds >= 0) {
      f.minBedrooms = beds;
    }
    return Object.keys(f).length > 0 ? f : undefined;
  }, [outcode, maxPricePounds, minBeds]);

  const { data, isLoading, isError, refetch } = trpc.listings.list.useQuery({
    filter,
    sortBy,
    sortDir: "desc",
  });

  const rows: ListingRow[] = data?.items ?? [];

  return (
    <main className="listings-page">
      <h1>Listings</h1>

      <form
        className="listings-filters"
        aria-label="Listing filters"
        onSubmit={(e) => e.preventDefault()}
      >
        <label>
          <span>Outcode</span>
          <input
            type="text"
            data-testid="filter-outcode"
            value={outcode}
            onChange={(e) => setOutcode(e.target.value)}
            placeholder="e.g. SE1"
          />
        </label>
        <label>
          <span>Max price (£)</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            data-testid="filter-max-price"
            value={maxPricePounds}
            onChange={(e) => setMaxPricePounds(e.target.value)}
            placeholder="e.g. 600000"
          />
        </label>
        <label>
          <span>Min bedrooms</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            data-testid="filter-min-beds"
            value={minBeds}
            onChange={(e) => setMinBeds(e.target.value)}
            placeholder="e.g. 2"
          />
        </label>
        <label>
          <span>Sort by</span>
          <select
            data-testid="sort-by"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as ListingSortField)}
          >
            {LISTING_SORT_FIELDS.map((field) => (
              <option key={field} value={field}>
                {SORT_LABELS[field]}
              </option>
            ))}
          </select>
        </label>
      </form>

      {isError ? (
        <div className="listings-error">
          <div role="alert">Couldn&apos;t load listings.</div>
          <button
            type="button"
            onClick={() => {
              void refetch();
            }}
          >
            Retry
          </button>
        </div>
      ) : (
        <div
          role="region"
          aria-label="Listings"
          aria-busy={isLoading ? "true" : undefined}
        >
          <table data-testid="listings-table" className="listings-table">
            <caption className="sr-only">
              Property listings, filterable by outcode, price and bedrooms.
            </caption>
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col">Outcode</th>
                <th scope="col">Price</th>
                <th scope="col">Beds</th>
                <th scope="col">Status</th>
                <th scope="col">Source</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={COLUMN_COUNT}>
                    {isLoading ? "Loading…" : "No listings match your filters."}
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const detailsId = `listing-details-${row.id}`;
                  const isExpanded = expandedId === row.id;
                  return (
                    <ListingRowGroup
                      key={row.id}
                      row={row}
                      detailsId={detailsId}
                      isExpanded={isExpanded}
                      onToggle={() =>
                        setExpandedId(isExpanded ? null : row.id)
                      }
                    />
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

interface ListingRowGroupProps {
  row: ListingRow;
  detailsId: string;
  isExpanded: boolean;
  onToggle: () => void;
}

function ListingRowGroup({
  row,
  detailsId,
  isExpanded,
  onToggle,
}: ListingRowGroupProps) {
  return (
    <>
      <tr data-testid="listing-row" data-address={row.addressNormalized}>
        <td data-col="address">{row.addressNormalized}</td>
        <td data-col="outcode">{row.outcode ?? "—"}</td>
        <td data-col="price">{formatPrice(row.pricePence)}</td>
        <td data-col="beds">{formatBeds(row.bedrooms)}</td>
        <td data-col="status">{STATUS_LABELS[row.listingStatus]}</td>
        <td data-col="source">
          {row.listingUrl ? (
            <a
              data-testid="listing-source-link"
              href={row.listingUrl}
              target="_blank"
              rel="noreferrer"
            >
              View source
            </a>
          ) : (
            <span data-testid="listing-source-none" aria-disabled="true">
              Email only
            </span>
          )}
        </td>
        <td data-col="details">
          <button
            type="button"
            aria-expanded={isExpanded}
            aria-controls={detailsId}
            onClick={onToggle}
          >
            {isExpanded ? "Hide" : "Show"}
          </button>
        </td>
      </tr>
      {isExpanded ? (
        <tr id={detailsId} data-testid="listing-details">
          <td colSpan={COLUMN_COUNT}>
            {/* Placeholder — photo features + score rationale wired in M5. */}
            Photo features and match score arrive in M5.
          </td>
        </tr>
      ) : null}
    </>
  );
}
