/**
 * ListingsPage — the HomeRanger listings screen, a faithful port of the 2nd
 * claude.ai/design handoff (docs/design/homeranger-design/project/app/listings.jsx)
 * onto real tRPC data.
 *
 * The product loop is discover → outreach → ingest → list: homes arrive from
 * estate-agent emails, get AI-scored against the user's taste, and land here.
 * So there are NO search filters — just the list, sortable, in a table or card
 * view. Rows are sorted client-side over the fetched page (score / newest /
 * price / bedrooms / address); the server returns the page ordered by match
 * score with each row's `combinedScore` attached. Clicking a row opens the
 * agent's source page in a new tab (email-only homes have no link).
 *
 * Listing *status* is deliberately not shown — the DB keeps `listingStatus`,
 * the UI just stops surfacing it. Instead each home carries a bookmark
 * ("I'm interested"); bookmarks persist in localStorage ("hs-interested") and
 * power a sticky interest bar + a follow-up modal that drafts one warm note per
 * agency. "Send" is a mock here (real send lands in a later PR).
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { useEffect, useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@homeranger/backend-core";
import type { ScoutFilter } from "./ScoutsPage";
import { trpc } from "../lib/trpc";
import { Icon } from "../components/Icon";
import {
  Button,
  Chip,
  EpcBadge,
  Photo,
  ScoreRing,
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
  bathrooms: number | null;
  propertyType: string | null; // humanised, e.g. "Semi-detached"
  epc: string | null; // EPC band a–g (or null/unknown → no badge)
  agency: string | null; // agency name, falling back to the agent's email
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

/** Shown in the table Agent column + as the follow-up grouping key. */
const NO_AGENCY_LABEL = "your agent";

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
    bathrooms: item.bathrooms,
    propertyType: humanizePropertyType(item.propertyType),
    epc: item.epcRating,
    agency: item.agency,
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

/* ---- Interest bookmark --------------------------------------------------- */
interface InterestButtonProps {
  on: boolean;
  onToggle: () => void;
  size?: number;
  className?: string;
}

/** Bookmark toggle — "I'm interested", queues the home for a follow-up. */
function InterestButton({ on, onToggle, size = 18, className = "" }: InterestButtonProps) {
  return (
    <button
      type="button"
      className={`intbtn${on ? " is-on" : ""} ${className}`.trim()}
      data-testid="interest-button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-pressed={on}
      title={on ? "Saved to follow-ups" : "I'm interested — save for follow-up"}
    >
      <Icon name="bookmark" size={size} />
    </button>
  );
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
  interested: string[];
  onToggleInterest: (id: string) => void;
}

function ListingsTable({ rows, sort, onSort, interested, onToggleInterest }: TableProps) {
  return (
    <div className="tablewrap">
      <table className="listings" data-testid="listings-table">
        <caption className="sr-only">
          Property listings, sortable by match score, price, bedrooms, address,
          and recency.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="col-int" aria-label="Interested" />
            <SortHeader id="address" label="Home" sort={sort} onSort={onSort} />
            <SortHeader id="price" label="Price" num sort={sort} onSort={onSort} />
            <th scope="col" className="col-bedbath">
              Beds
            </th>
            <SortHeader id="score" label="Match" num sort={sort} onSort={onSort} />
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
          {rows.map((l) => {
            const on = interested.includes(l.id);
            return (
              <tr
                key={l.id}
                className={`row${l.listingUrl ? " clickable" : ""}${on ? " is-interested" : ""}`}
                data-testid="listing-row"
                data-address={l.address}
                onClick={() => openSource(l.listingUrl)}
              >
                <td className="col-int">
                  <InterestButton
                    on={on}
                    onToggle={() => onToggleInterest(l.id)}
                    size={17}
                  />
                </td>
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
                  {l.bedrooms != null ? (
                    <span className="bedbath">
                      <span>
                        <Icon name="bed-double" size={15} />
                        {l.bedrooms}
                      </span>
                      <span>
                        <Icon name="bath" size={15} />
                        {l.bathrooms ?? "—"}
                      </span>
                    </span>
                  ) : (
                    <span className="bedbath na">—</span>
                  )}
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
                <td className="agent-cell col-agent">{l.agency ?? "—"}</td>
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
                      title="The agent sent this by email — no link included"
                      aria-label="Email only"
                    >
                      <Icon name="mail" size={15} />
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---- Card view ----------------------------------------------------------- */
interface CardProps {
  row: ViewRow;
  interested: boolean;
  onToggleInterest: () => void;
}

function ListingCard({ row: l, interested, onToggleInterest }: CardProps) {
  const clickable = Boolean(l.listingUrl);
  return (
    <div
      className={`hs-card pcard${clickable ? " hs-card--interactive" : ""}${interested ? " is-interested" : ""}`}
      data-testid="listing-row"
      data-address={l.address}
      onClick={() => openSource(l.listingUrl)}
    >
      <div className="pcard-photo">
        <Photo count={null} />
        <InterestButton
          on={interested}
          onToggle={onToggleInterest}
          className="intbtn--overlay"
          size={18}
        />
      </div>
      <div className="body">
        <div className="head">
          <div style={{ minWidth: 0 }}>
            <div className="price">{gbp(l.price)}</div>
            <div className="addr">{l.address}</div>
            <div className="sub">{subline(l)}</div>
          </div>
        </div>
        <div className="chips">
          {l.bedrooms != null && <Chip icon="bed-double">{l.bedrooms}</Chip>}
          {l.bathrooms != null && <Chip icon="bath">{l.bathrooms}</Chip>}
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

/* ---- Follow-up flow ------------------------------------------------------ */
function joinNames(arr: string[]): string {
  if (arr.length === 1) {
    return arr[0]!;
  }
  return arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];
}

/** One warm, in-voice note covering all of an agency's bookmarked homes. */
function followUpEmail(rows: ViewRow[], senderName?: string | null): string {
  const single = rows.length === 1;
  const names = joinNames(rows.map((l) => l.address));
  return (
    `Hello,\n\n` +
    `Thank you for sending ${single ? "this" : "these"} through. I'm very interested in ` +
    `${names}${single ? "" : " — each looks like a strong fit"}.\n\n` +
    `Could we arrange ${single ? "a viewing" : "viewings"}? I'm flexible on timing and ready to ` +
    `move quickly for the right place. If anything similar is coming up that hasn't reached the ` +
    `portals yet, I'd be glad to hear about it first.\n\n` +
    (senderName ? `Many thanks,\n${senderName}` : `Many thanks`)
  );
}

interface AgencyGroup {
  agency: string;
  rows: ViewRow[];
}

/** Group the bookmarked homes by agency (null agency → "your agent"). */
function groupByAgency(rows: ViewRow[]): AgencyGroup[] {
  const m = new Map<string, ViewRow[]>();
  for (const l of rows) {
    const key = l.agency ?? NO_AGENCY_LABEL;
    const bucket = m.get(key);
    if (bucket) {
      bucket.push(l);
    } else {
      m.set(key, [l]);
    }
  }
  return Array.from(m, ([agency, rs]) => ({ agency, rows: rs }));
}

interface FollowUpModalProps {
  rows: ViewRow[];
  onClose: () => void;
  onSent: () => void;
}

function FollowUpModal({ rows, onClose, onSent }: FollowUpModalProps) {
  // "Send" is a MOCK → success state. No real email goes out (that lands in a
  // later PR); this just flips to the confirmation.
  const [sent, setSent] = useState(false);
  const { data: sender } = trpc.outreach.senderName.useQuery();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  // One message per agency, even if you bookmarked several of their homes.
  const groups = useMemo(() => groupByAgency(rows), [rows]);

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Follow up with agents"
        data-testid="followup-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <div>
            <span className="eyebrow">Follow up</span>
            <h2 className="modal__title">
              {sent
                ? "Follow-ups sent"
                : `Tell ${groups.length} ${groups.length === 1 ? "agent" : "agents"} you're interested`}
            </h2>
          </div>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </div>

        {sent ? (
          <div className="confirm-body" data-testid="followup-sent">
            <div className="confirm-mark confirm-mark--ok">
              <Icon name="check" size={24} />
            </div>
            <h2 className="confirm-title">
              Sent to {groups.length} {groups.length === 1 ? "agent" : "agents"}
            </h2>
            <p className="confirm-text">
              Each agent gets a single, warm note about the{" "}
              {rows.length === 1 ? "home" : "homes"} you liked. Their replies come
              straight back into your inbox — nothing is shared beyond the agents
              you chose.
            </p>
          </div>
        ) : (
          <div className="modal__body">
            <p className="followup-intro">
              One message per agent, in your voice. Review and send — or close to
              keep them saved.
            </p>
            {groups.map((g) => (
              <div className="followup-group" data-testid="followup-group" key={g.agency}>
                <div className="fg-head">
                  <span className="fg-agency">
                    <Icon name="mail" size={15} /> {g.agency}
                  </span>
                  <span className="fg-count">
                    {g.rows.length} {g.rows.length === 1 ? "home" : "homes"}
                  </span>
                </div>
                <div className="fg-homes">
                  {g.rows.map((l) => (
                    <span className="fg-home" key={l.id}>
                      {l.address} · {gbp(l.price)}
                    </span>
                  ))}
                </div>
                <pre className="preview__body fg-draft">{followUpEmail(g.rows, sender?.name)}</pre>
              </div>
            ))}
          </div>
        )}

        <div className="modal__foot modal__foot--end">
          {sent ? (
            <Button variant="primary" onClick={onSent}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>
                Not now
              </Button>
              <Button
                variant="primary"
                icon="mail"
                data-testid="followup-send"
                onClick={() => setSent(true)}
              >
                Send {groups.length} {groups.length === 1 ? "follow-up" : "follow-ups"}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface InterestBarProps {
  count: number;
  onReview: () => void;
  onClear: () => void;
}

function InterestBar({ count, onReview, onClear }: InterestBarProps) {
  return (
    <div className="interest-bar" role="status" data-testid="interest-bar">
      <span className="ib-count">
        <Icon name="bookmark" size={16} />
        <b>{count}</b> {count === 1 ? "home" : "homes"} you're interested in
      </span>
      <div className="ib-actions">
        <button type="button" className="ib-clear" onClick={onClear}>
          Clear
        </button>
        <Button
          variant="primary"
          size="sm"
          icon="mail"
          data-testid="draft-followups"
          onClick={onReview}
        >
          Draft follow-ups
        </Button>
      </div>
    </div>
  );
}

/* ---- Interest persistence ------------------------------------------------ */
const INTEREST_KEY = "hs-interested";

/** Read the bookmarked listing ids from localStorage, tolerating bad data. */
function readInterested(): string[] {
  try {
    const raw = localStorage.getItem(INTEREST_KEY);
    const parsed = raw == null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
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
  const [interested, setInterested] = useState<string[]>(readInterested);
  const [followUp, setFollowUp] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(INTEREST_KEY, JSON.stringify(interested));
    } catch {
      // Best-effort persistence; ignore quota/availability errors.
    }
  }, [interested]);

  function toggleInterest(id: string) {
    setInterested((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

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

  // Only the bookmarked homes that are still in the current page can be drafted.
  const interestedRows = useMemo(
    () => rows.filter((l) => interested.includes(l.id)),
    [rows, interested],
  );

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
              {rows.length === 1 ? "home" : "homes"} from your agents
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
            <ListingsTable
              rows={rows}
              sort={sort}
              onSort={onSort}
              interested={interested}
              onToggleInterest={toggleInterest}
            />
          ) : (
            <div className="grid-cards">
              {rows.map((l) => (
                <ListingCard
                  key={l.id}
                  row={l}
                  interested={interested.includes(l.id)}
                  onToggleInterest={() => toggleInterest(l.id)}
                />
              ))}
            </div>
          )}

          <div className="foot-note">
            <Icon name="shield-check" size={14} />
            Click a home to open the agent&rsquo;s page · bookmark homes you like
            to follow up with their agents
          </div>

          {interestedRows.length > 0 && (
            <InterestBar
              count={interestedRows.length}
              onReview={() => setFollowUp(true)}
              onClear={() => setInterested([])}
            />
          )}

          {followUp && interestedRows.length > 0 && (
            <FollowUpModal
              rows={interestedRows}
              onClose={() => setFollowUp(false)}
              onSent={() => {
                setInterested([]);
                setFollowUp(false);
              }}
            />
          )}
        </>
      )}
    </main>
  );
}
