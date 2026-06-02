/**
 * ListingsPage — the HomeScout listings screen, a faithful port of the
 * claude.ai/design handoff (docs/design/homescout-design/project/app/listings.jsx)
 * onto real tRPC data.
 *
 * The product loop is discover → outreach → ingest → list: homes arrive from
 * estate-agent emails, get AI-scored against the user's taste, and land here.
 * So there are NO search filters — just the list, sortable, in a table or card
 * view. Rows are sorted client-side over the fetched page (score / newest /
 * price / bedrooms / address); the server returns the page ordered by match
 * score with each row's `combinedScore` attached. Clicking a row opens the
 * agent's source page in a new tab (pre-market homes are email-only → no link).
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@homescout/backend-core";
import type { ListingStatus } from "@homescout/shared";
import type { ScoutFilter } from "./ScoutsPage";
import { trpc } from "../lib/trpc";
import { Icon } from "../components/Icon";
import {
  Button,
  Chip,
  EpcBadge,
  Photo,
  ScoreRing,
  StatusBadge,
  scoreLabel,
} from "../components/ui";
import {
  ageHoursSince,
  gbp,
  humanizePropertyType,
  penceToPounds,
  relativeTime,
} from "../lib/format";
import { useStored } from "../lib/useStored";

type ListItem =
  inferRouterOutputs<AppRouter>["listings"]["list"]["items"][number];

/** The flattened row the table + cards render + sort over. */
interface ViewRow {
  id: string;
  address: string;
  postcode: string | null;
  outcode: string | null;
  price: number | null; // whole pounds
  bedrooms: number | null;
  propertyType: string | null; // humanised, e.g. "Semi-detached"
  epc: string | null; // EPC band a–g (or null/unknown → no badge)
  status: ListingStatus;
  listingUrl: string | null;
  score: number | null; // 0–100 match score
  ageHours: number; // numeric sort key behind "Seen"
  lastSeen: string; // human relative time
}

type SortKey = "score" | "ageHours" | "price" | "bedrooms" | "address";
interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}
interface SortDef {
  label: string;
  type: "num" | "str";
  dir: "asc" | "desc"; // default direction when this key is first chosen
}

const SORTS: Record<SortKey, SortDef> = {
  score: { label: "Match score", type: "num", dir: "desc" },
  ageHours: { label: "Newest first", type: "num", dir: "asc" },
  price: { label: "Price", type: "num", dir: "desc" },
  bedrooms: { label: "Bedrooms", type: "num", dir: "desc" },
  address: { label: "Address", type: "str", dir: "asc" },
};

function compare(a: ViewRow, b: ViewRow, key: SortKey, dir: "asc" | "desc"): number {
  if (SORTS[key].type === "str") {
    const r = String(a[key]).localeCompare(String(b[key]));
    return dir === "asc" ? r : -r;
  }
  const av = a[key] as number | null;
  const bv = b[key] as number | null;
  const an = av == null;
  const bn = bv == null;
  if (an && bn) {
    return 0;
  }
  if (an) {
    return 1; // nulls (un-scored, no price, …) always sink
  }
  if (bn) {
    return -1;
  }
  return dir === "asc" ? av - bv : bv - av;
}

function openSource(url: string | null): void {
  if (url) {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function toViewRow(item: ListItem, now: Date): ViewRow {
  return {
    id: item.id,
    address: item.addressNormalized,
    postcode: item.postcode,
    outcode: item.outcode,
    price: penceToPounds(item.pricePence),
    bedrooms: item.bedrooms,
    propertyType: humanizePropertyType(item.propertyType),
    epc: item.epcRating,
    status: item.listingStatus,
    listingUrl: item.listingUrl,
    // combinedScore is 0..1; clamp the ×100 to a valid 0–100 ring fill in case a
    // bad score ever round-trips out of range.
    score:
      item.combinedScore == null
        ? null
        : Math.min(100, Math.max(0, Math.round(item.combinedScore * 100))),
    ageHours: ageHoursSince(item.lastSeenAt, now),
    lastSeen: relativeTime(item.lastSeenAt, now),
  };
}

/** "Postcode · Property type", omitting whichever is missing. */
function subline(row: ViewRow): string {
  return [row.postcode, row.propertyType].filter(Boolean).join(" · ");
}

/* ---- Table view ---------------------------------------------------------- */
interface SortHeaderProps {
  id: SortKey;
  label: string;
  num?: boolean;
  extraClass?: string;
  sort: SortState;
  onSort: (key: SortKey) => void;
}

function SortHeader({ id, label, num, extraClass, sort, onSort }: SortHeaderProps) {
  const active = sort.key === id;
  const cls = [
    num ? "num" : "",
    extraClass ?? "",
    "sortable",
    active ? "active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <th
      scope="col"
      className={cls}
      onClick={() => onSort(id)}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <span className="th-inner">
        {label}
        <span className="sort-ind">
          <Icon name={active && sort.dir === "asc" ? "chevron-up" : "chevron-down"} size={14} />
        </span>
      </span>
    </th>
  );
}

interface TableProps {
  rows: ViewRow[];
  sort: SortState;
  onSort: (key: SortKey) => void;
}

function ListingsTable({ rows, sort, onSort }: TableProps) {
  return (
    <div className="tablewrap">
      <table className="listings" data-testid="listings-table">
        <caption className="sr-only">
          Property listings, sortable by match score, price, bedrooms, address,
          and recency.
        </caption>
        <thead>
          <tr>
            <SortHeader id="address" label="Home" sort={sort} onSort={onSort} />
            <SortHeader id="price" label="Price" num sort={sort} onSort={onSort} />
            <th scope="col" className="col-bedbath">
              Beds
            </th>
            <SortHeader id="score" label="Match" num sort={sort} onSort={onSort} />
            <th scope="col">Status</th>
            <th scope="col" className="col-agent">
              Agent
            </th>
            <SortHeader
              id="ageHours"
              label="Seen"
              num
              extraClass="col-seen"
              sort={sort}
              onSort={onSort}
            />
            <th scope="col" className="col-src" aria-label="Source" />
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr
              key={l.id}
              className={`row${l.listingUrl ? " clickable" : ""}`}
              data-testid="listing-row"
              data-address={l.address}
              onClick={() => openSource(l.listingUrl)}
            >
              <td>
                <div className="cell-addr">
                  <Photo className="thumb" />
                  <span className="at">
                    <b>{l.address}</b>
                    <small>{subline(l)}</small>
                  </span>
                </div>
              </td>
              <td className="num price-cell">{gbp(l.price)}</td>
              <td className="col-bedbath">
                <span className="bedbath">
                  <span>
                    <Icon name="bed-double" size={15} />
                    {l.bedrooms ?? "—"}
                  </span>
                </span>
              </td>
              <td className="num">
                <div
                  className="score-cell"
                  data-testid="match-score"
                  style={{ display: "inline-flex", justifyContent: "flex-end", width: "100%" }}
                >
                  <ScoreRing value={l.score} size={36} />
                </div>
              </td>
              <td>
                <StatusBadge status={l.status} />
              </td>
              <td className="agent-cell col-agent">—</td>
              <td className="num col-seen">
                <span className="seen-cell">{l.lastSeen}</span>
              </td>
              <td className="col-src">
                {l.listingUrl ? (
                  <a
                    className="src-icon"
                    data-testid="listing-source-link"
                    href={l.listingUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    title="View on the agent's site"
                    aria-label="View source"
                  >
                    <Icon name="external-link" size={16} />
                  </a>
                ) : (
                  <span
                    className="src-icon src-icon--mail"
                    data-testid="listing-source-none"
                    title="Email only — not yet listed"
                    aria-label="Email only"
                  >
                    <Icon name="mail" size={15} />
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---- Card view ----------------------------------------------------------- */
function ListingCard({ row: l }: { row: ViewRow }) {
  const clickable = Boolean(l.listingUrl);
  return (
    <div
      className={`hs-card pcard${clickable ? " hs-card--interactive" : ""}`}
      data-testid="listing-row"
      data-address={l.address}
      onClick={() => openSource(l.listingUrl)}
    >
      <Photo count={null} />
      <div className="body">
        <div className="head">
          <div style={{ minWidth: 0 }}>
            <div className="price">{gbp(l.price)}</div>
            <div className="addr">{l.address}</div>
            <div className="sub">{subline(l)}</div>
          </div>
          <StatusBadge status={l.status} />
        </div>
        <div className="chips">
          {l.bedrooms != null && <Chip icon="bed-double">{l.bedrooms}</Chip>}
          {l.outcode && <Chip icon="map-pin">{l.outcode}</Chip>}
          <EpcBadge band={l.epc} />
        </div>
        <div className="foot">
          <div className="hs-score">
            <span data-testid="match-score" style={{ display: "contents" }}>
              <ScoreRing value={l.score} />
            </span>
            <div className="hs-score__label">
              <b>{scoreLabel(l.score)}</b>
              <span>
                {l.score == null ? "awaiting analysis" : `${l.score} / 100 · ${l.lastSeen}`}
              </span>
            </div>
          </div>
          {l.listingUrl ? (
            <a
              className="src-link"
              data-testid="listing-source-link"
              href={l.listingUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              Source <Icon name="external-link" size={14} />
            </a>
          ) : (
            <span className="src-none" data-testid="listing-source-none">
              <Icon name="mail" size={13} /> Email only
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- Screen -------------------------------------------------------------- */
export interface ListingsPageProps {
  /** When set, the list is scoped to a scout's outcodes + a banner is shown. */
  scoutFilter?: ScoutFilter | null;
  /** Clear the scout filter (the banner's "All listings" action). */
  onClearScoutFilter?: () => void;
}

export function ListingsPage({
  scoutFilter = null,
  onClearScoutFilter,
}: ListingsPageProps = {}) {
  const [view, setView] = useStored<"table" | "cards">("hs-view", "table", [
    "table",
    "cards",
  ]);
  const [sort, setSort] = useState<SortState>({ key: "score", dir: "desc" });

  // No manual filters: fetch the page ordered by match score (server attaches
  // each row's combinedScore) and re-sort client-side on header/dropdown
  // change. The one exception is a scout filter — when a scout's "View homes"
  // pushed us here, the list is scoped to that scout's outcodes.
  const { data, isLoading, isError, refetch } = trpc.listings.list.useQuery({
    ...(scoutFilter && scoutFilter.outcodes.length > 0
      ? { filter: { outcodes: scoutFilter.outcodes } }
      : {}),
    sortBy: "combinedScore",
    sortDir: "desc",
    limit: 100,
  });

  // Recompute "now" only when the data changes, so relative times + age sort
  // keys are stable across re-sorts within the same fetched page.
  const now = useMemo(() => new Date(), [data]);
  const rows = useMemo(() => {
    const mapped = (data?.items ?? []).map((item) => toViewRow(item, now));
    return mapped.sort((a, b) => compare(a, b, sort.key, sort.dir));
  }, [data, now, sort]);

  function onSort(key: SortKey) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: SORTS[key].dir },
    );
  }

  const preMarket = rows.filter((l) => l.status === "pre_market").length;
  const hasMore = Boolean(data?.nextCursor);

  return (
    <main>
      <div className="page-head">
        <h1 className="t-h1">Listings</h1>
        <p>
          Homes your agents have sent in — read from their emails, scored against
          your taste, and linked back to the source. Found before it&rsquo;s
          listed.
        </p>
      </div>

      {scoutFilter && (
        <div className="scout-filter" data-testid="scout-filter-banner">
          <div className="sf-left">
            <span className="sf-eyebrow">
              <Icon name="search" size={13} /> Scout
            </span>
            <span className="sf-name">{scoutFilter.name}</span>
            {scoutFilter.outcodes.length > 0 && (
              <span className="sf-outcodes">
                {scoutFilter.outcodes.map((oc) => (
                  <span key={oc} className="sf-oc">
                    {oc}
                  </span>
                ))}
              </span>
            )}
            <span
              className={`sf-status sf-status--${
                scoutFilter.status === "active" ? "active" : "paused"
              }`}
            >
              <Icon name={scoutFilter.status === "active" ? "play" : "pause"} size={11} />
              {scoutFilter.status === "active" ? "Active" : "Paused"}
            </span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            data-testid="scout-filter-clear"
            onClick={() => onClearScoutFilter?.()}
          >
            All listings
          </Button>
        </div>
      )}

      {isError ? (
        <div className="empty" role="alert">
          <p>Couldn&rsquo;t load listings.</p>
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
          <p>Loading listings…</p>
        </div>
      ) : (
        <>
          <div className="controls">
            <span className="count" data-testid="listings-count">
              <b>
                {rows.length}
                {hasMore ? "+" : ""}
              </b>{" "}
              homes · <b className="gold">{preMarket}</b> pre-market
            </span>
            <div className="controls__right">
              <div className="sortwrap">
                <label htmlFor="sortby">Sort</label>
                <select
                  id="sortby"
                  data-testid="sort-by"
                  className="hs-select"
                  value={sort.key}
                  onChange={(e) =>
                    setSort({
                      key: e.target.value as SortKey,
                      dir: SORTS[e.target.value as SortKey].dir,
                    })
                  }
                >
                  {(Object.keys(SORTS) as SortKey[]).map((k) => (
                    <option key={k} value={k}>
                      {SORTS[k].label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="viewtoggle" role="group" aria-label="View">
                <button
                  type="button"
                  data-testid="view-table"
                  aria-pressed={view === "table"}
                  onClick={() => setView("table")}
                  aria-label="Table view"
                >
                  <Icon name="rows-3" size={17} />
                </button>
                <button
                  type="button"
                  data-testid="view-cards"
                  aria-pressed={view === "cards"}
                  onClick={() => setView("cards")}
                  aria-label="Card view"
                >
                  <Icon name="layout-grid" size={17} />
                </button>
              </div>
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="empty" data-testid="listings-empty">
              <Photo style={{ aspectRatio: "1" }} />
              <p>
                No listings yet. Once your agents reply, the homes they send
                appear here.
              </p>
            </div>
          ) : view === "table" ? (
            <ListingsTable rows={rows} sort={sort} onSort={onSort} />
          ) : (
            <div className="grid-cards">
              {rows.map((l) => (
                <ListingCard key={l.id} row={l} />
              ))}
            </div>
          )}

          <div className="foot-note">
            <Icon name="shield-check" size={14} />
            Click a home to open the agent&rsquo;s page · pre-market homes are
            email-only until they list
          </div>
        </>
      )}
    </main>
  );
}
