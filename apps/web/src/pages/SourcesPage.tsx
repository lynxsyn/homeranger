/**
 * SourcesPage — the HomeRanger Sources screen, the read-only sibling of the
 * Agents screen. Where Agents shows the estate AGENTS HomeRanger contacted, this
 * shows the crawled listing SOURCES (auction houses + land/farm sites) the
 * scheduler scrapes on a cadence, with their configured coverage and the live
 * telemetry of how many listings each has ingested and when it last found one.
 *
 * Unlike Agents this is a GLOBAL catalogue with no per-user/PII data, so the tab
 * is visible to every authenticated user (protectedProcedure, not operator-only)
 * and there are NO row actions — a source is config, not something you remove.
 *
 * Each row's "View N listings" drills out to the Listings view, scoped to that
 * source's `primarySource` via a lifted App-level filter + a banner (mirroring
 * the search-filter drill-in). The three metric tiles are derived client-side
 * from the `sources.list` rows (no second round-trip); the kind-filter chips
 * narrow the table client-side.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@homeranger/backend-core";
import type { ListingSource, SourceKind } from "@homeranger/shared";
import { trpc } from "../lib/trpc";
import { Icon } from "../components/Icon";
import { Button } from "../components/ui";
import { InfoTip } from "../components/InfoTip";
import { relativeTime } from "../lib/format";

type SourceRow = inferRouterOutputs<AppRouter>["sources"]["list"][number];

/** A source drill-in: the listings scoped to one crawled source. */
export interface SourceFilter {
  /** The ListingSource enum value → filters Listing.primarySource. */
  id: ListingSource;
  /** Banner display name, e.g. "Auction House". */
  name: string;
  /** Banner icon (gavel for auction, trees for land). */
  kind: SourceKind;
  /** Banner link-out host, e.g. "auctionhouse.co.uk" (no scheme). */
  domain: string;
}

/* ---- Source mark ---------------------------------------------------------- */
/** The gold gavel (auction houses) / green trees (land & farm) row glyph. */
function SourceMark({ kind }: { kind: SourceKind }) {
  return (
    <span className={`src-mark src-mark--${kind}`} aria-hidden="true">
      <Icon name={kind === "auction" ? "gavel" : "trees"} size={18} />
    </span>
  );
}

/* ---- Coverage cell -------------------------------------------------------- */
/** A source's CONFIGURED coverage: the human region label + the outcode prefix
 *  chips. Static (the crawl config), not the rolling agent CoverageSummary. */
function SourceCoverage({ outcodes, label }: { outcodes: string[]; label: string }) {
  return (
    <div className="cov-cell cov-static">
      {label && <span className="cov-static__town">{label}</span>}
      <span className="sf-outcodes">
        {outcodes.map((oc) => (
          <span key={oc} className="sf-oc">
            {oc}
          </span>
        ))}
      </span>
    </div>
  );
}

/* ---- Headline metric tile ------------------------------------------------- */
interface SourceMetricProps {
  icon: string;
  value: ReactNode;
  label: string;
  testid: string;
}

function SourceMetric({ icon, value, label, testid }: SourceMetricProps) {
  return (
    <div className="ag-metric" data-testid={testid}>
      <span className="agm-ic">
        <Icon name={icon} size={16} />
      </span>
      <span className="agm-val">{value}</span>
      <span className="agm-label">{label}</span>
    </div>
  );
}

/* ---- Kind filter chips ---------------------------------------------------- */
type KindFilter = "all" | SourceKind;

const KIND_FILTERS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "auction", label: "Auction houses" },
  { id: "land", label: "Land & farm" },
];

/* ---- Screen --------------------------------------------------------------- */
export interface SourcesPageProps {
  /** Drill out to the Listings view scoped to this source's lots. */
  onViewLots: (filter: SourceFilter) => void;
  /** The signed-in user is the operator → show the operator-only "Refresh
   *  listings" control. The backend mutation is operatorProcedure regardless;
   *  this only hides the button from non-operators (UI hiding is not a security
   *  boundary). */
  isOperator?: boolean;
}

export function SourcesPage({
  onViewLots,
  isOperator = false,
}: SourcesPageProps) {
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");

  const { data, isLoading, isError, refetch } = trpc.sources.list.useQuery();
  // Operator-only: trigger the scrape now instead of waiting for the 24h cron.
  const refresh = trpc.sources.refresh.useMutation();
  const rows: SourceRow[] = data ?? [];

  // The three metric tiles derive from the fetched rows (no second round-trip):
  // sources monitored, total lots ingested across all sources, and the most
  // recent observation across them.
  const monitored = rows.length;
  const totalLots = rows.reduce((n, r) => n + r.lotsFound, 0);
  const latest = rows.reduce<Date | null>(
    (acc, r) =>
      r.latestObservedAt && (!acc || r.latestObservedAt > acc)
        ? r.latestObservedAt
        : acc,
    null,
  );

  const filtered = rows.filter(
    (r) => kindFilter === "all" || r.kind === kindFilter,
  );

  return (
    <main>
      <h1 className="sr-only">Sources</h1>

      <div className="ag-metrics">
        <SourceMetric
          icon="rss"
          value={monitored}
          label="Monitored sources"
          testid="sources-metric-sources"
        />
        <SourceMetric
          icon="home"
          value={totalLots}
          label="Listings ingested"
          testid="sources-metric-lots"
        />
        <SourceMetric
          icon="route"
          value={latest ? relativeTime(latest) : "—"}
          label="Latest activity"
          testid="sources-metric-latest"
        />
      </div>

      {isError ? (
        <div className="empty" role="alert">
          <p>Couldn&rsquo;t load sources.</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void refetch();
            }}
          >
            Retry
          </Button>
        </div>
      ) : isLoading ? (
        <div className="empty" aria-busy="true">
          <p>Loading sources…</p>
        </div>
      ) : (
        <>
          <div className="controls">
            <div
              className="statusfilter"
              role="group"
              aria-label="Filter by kind"
            >
              {KIND_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`sf-chip${kindFilter === f.id ? " is-on" : ""}`}
                  data-testid={`source-filter-${f.id}`}
                  aria-pressed={kindFilter === f.id}
                  onClick={() => setKindFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <span className="ctrl-left">
              <span className="count" data-testid="sources-count">
                <b>{filtered.length}</b>{" "}
                {filtered.length === 1 ? "source" : "sources"}
              </span>
              <InfoTip label="About sources" align="right" size={14}>
                <b>The sites HomeRanger crawls.</b> Auction houses and land &amp;
                farm listings, scraped on a schedule and scored against your
                taste. Their listings appear in your feed, found a different way
                to the agent inbox.
              </InfoTip>
              {isOperator && (
                <span className="src-refresh">
                  <Button
                    variant="secondary"
                    size="sm"
                    data-testid="sources-refresh"
                    disabled={refresh.isPending}
                    onClick={() => refresh.mutate()}
                  >
                    {refresh.isPending ? "Refreshing…" : "Refresh listings"}
                  </Button>
                  {refresh.isSuccess && (
                    <span
                      className="src-refresh__note"
                      role="status"
                      data-testid="sources-refresh-status"
                    >
                      Crawl queued - new listings appear here once found
                    </span>
                  )}
                  {refresh.isError && (
                    <span
                      className="src-refresh__note src-refresh__note--err"
                      role="alert"
                      data-testid="sources-refresh-error"
                    >
                      {refresh.error.message}
                    </span>
                  )}
                </span>
              )}
            </span>
          </div>

          {filtered.length === 0 ? (
            <div className="empty" data-testid="sources-empty">
              <div className="empty-mark">
                <Icon name="rss" size={26} />
              </div>
              <p>No sources in this view yet.</p>
            </div>
          ) : (
            <div className="tablewrap">
              <table
                className="listings sources-table"
                data-testid="sources-table"
              >
                <caption className="sr-only">Crawled listing sources</caption>
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col" className="col-cov">
                      Coverage
                    </th>
                    <th scope="col" className="num col-lots">
                      Listings found
                    </th>
                    <th scope="col" className="num col-seen">
                      Latest listing
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s) => (
                    <tr
                      key={s.id}
                      className="row"
                      data-testid="source-row"
                      data-source={s.id}
                    >
                      <td>
                        <div className="cell-source">
                          <SourceMark kind={s.kind} />
                          <span className="at">
                            <b>{s.name}</b>
                            <a
                              className="src-site"
                              href={`https://${s.domain}`}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {s.domain}
                              <Icon name="external-link" size={13} />
                            </a>
                          </span>
                        </div>
                      </td>
                      <td className="col-cov">
                        <SourceCoverage
                          outcodes={s.coverageOutcodes}
                          label={s.coverageLabel}
                        />
                      </td>
                      <td className="num col-lots">
                        <button
                          type="button"
                          className="lots-link"
                          data-testid="source-lots-link"
                          onClick={() =>
                            onViewLots({
                              id: s.id,
                              name: s.name,
                              kind: s.kind,
                              domain: s.domain,
                            })
                          }
                        >
                          <Icon name="home" size={14} />
                          View {s.lotsFound} listings
                          <Icon name="arrow-right" size={13} />
                        </button>
                      </td>
                      <td className="num col-seen">
                        <span className="seen-cell">
                          {s.latestObservedAt
                            ? relativeTime(s.latestObservedAt)
                            : "—"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="foot-note">
            <Icon name="route" size={14} />
            Crawled on a schedule and scored against your taste - the same
            listings table, found a different way
          </div>
        </>
      )}
    </main>
  );
}
