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
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@homeranger/backend-core";
import { SOURCE_NAMES } from "@homeranger/shared";
import type { SearchFilter } from "./SearchesPage";
import type { SourceFilter } from "./SourcesPage";
import { trpc } from "../lib/trpc";
import { Icon } from "../components/Icon";
import { InfoTip } from "../components/InfoTip";
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
import type { MapListing } from "../components/MapModal";

// Leaflet (~140 kB) is only pulled in when the map modal is actually opened, so
// it stays out of the initial listings bundle.
const MapModal = lazy(() =>
  import("../components/MapModal").then((m) => ({ default: m.MapModal })),
);

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
  sourceName: string | null; // crawled-source display name (scraped lots), else null
  listingUrl: string | null;
  imageUrl: string | null; // hotlinked source thumbnail (scraped lots), else null
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

/** The listings feed buckets (Active / Saved / Dismissed). */
type Bucket = "active" | "saved" | "dismissed";

interface BucketDef {
  id: Bucket;
  label: string;
}

const BUCKETS: BucketDef[] = [
  { id: "active", label: "Active" },
  { id: "saved", label: "Saved" },
  { id: "dismissed", label: "Dismissed" },
];

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
    // Scraped lots (auctionhouse / uklandandfarms) show the source name in the
    // From column; agent_email / manual fall through to the agency.
    sourceName: SOURCE_NAMES[item.primarySource] ?? null,
    listingUrl: item.listingUrl,
    imageUrl: item.imageUrl ?? null,
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

/* ---- Dismiss / restore --------------------------------------------------- */
interface DismissButtonProps {
  dismissed: boolean;
  onToggle: () => void;
  size?: number;
  className?: string;
}

/**
 * Hide a home from the working feed (a silent taste signal — never sent to the
 * agent). Reversible: the Dismissed bucket shows it with a restore affordance.
 */
function DismissButton({ dismissed, onToggle, size = 17, className = "" }: DismissButtonProps) {
  return (
    <button
      type="button"
      className={`dismissbtn${dismissed ? " is-restore" : ""} ${className}`.trim()}
      data-testid={dismissed ? "listing-restore" : "listing-dismiss"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-pressed={dismissed}
      title={dismissed ? "Restore to your listings" : "Dismiss — stop showing me this"}
      aria-label={dismissed ? "Restore home" : "Dismiss home"}
    >
      <Icon name={dismissed ? "rotate-ccw" : "eye-off"} size={size} />
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
  dismissed: string[];
  onToggleDismiss: (id: string) => void;
}

function ListingsTable({
  rows,
  sort,
  onSort,
  interested,
  onToggleInterest,
  dismissed,
  onToggleDismiss,
}: TableProps) {
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
              From
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
            const hidden = dismissed.includes(l.id);
            return (
              <tr
                key={l.id}
                className={`row${l.listingUrl ? " clickable" : ""}${on ? " is-interested" : ""}${hidden ? " is-dismissed" : ""}`}
                data-testid="listing-row"
                data-address={l.address}
                onClick={() => openSource(l.listingUrl)}
              >
                <td className="col-int">
                  <div className="rowacts">
                    <InterestButton
                      on={on}
                      onToggle={() => onToggleInterest(l.id)}
                      size={17}
                    />
                    <DismissButton
                      dismissed={hidden}
                      onToggle={() => onToggleDismiss(l.id)}
                    />
                  </div>
                </td>
                <td>
                  <div className="cell-addr">
                    <Photo src={l.imageUrl} className="thumb" />
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
                <td className="agent-cell col-agent">
                  {l.sourceName ?? l.agency ?? "—"}
                </td>
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
  dismissed: boolean;
  onToggleDismiss: () => void;
}

function ListingCard({
  row: l,
  interested,
  onToggleInterest,
  dismissed,
  onToggleDismiss,
}: CardProps) {
  const clickable = Boolean(l.listingUrl);
  return (
    <div
      className={`hs-card pcard${clickable ? " hs-card--interactive" : ""}${interested ? " is-interested" : ""}${dismissed ? " is-dismissed" : ""}`}
      data-testid="listing-row"
      data-address={l.address}
      onClick={() => openSource(l.listingUrl)}
    >
      <div className="pcard-photo">
        <Photo src={l.imageUrl} count={null} />
        <InterestButton
          on={interested}
          onToggle={onToggleInterest}
          className="intbtn--overlay"
          size={18}
        />
        <DismissButton
          dismissed={dismissed}
          onToggle={onToggleDismiss}
          className="dismissbtn--overlay"
          size={16}
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
    `${names}${single ? "" : ", each looks like a strong fit"}.\n\n` +
    `Could we arrange ${single ? "a viewing" : "viewings"}? I'm flexible on timing and happy to ` +
    `work around your diary. If anything similar is coming up that hasn't reached the ` +
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

/* ---- Screen -------------------------------------------------------------- */
export interface ListingsPageProps {
  /** When set, the list is scoped to a search's outcodes + a banner is shown. */
  searchFilter?: SearchFilter | null;
  /** Clear the search filter (the banner's "All listings" action). */
  onClearSearchFilter?: () => void;
  /** When set, the list is scoped to a crawled source + a banner is shown. */
  sourceFilter?: SourceFilter | null;
  /** Clear the source filter (the banner's "All listings" action). */
  onClearSourceFilter?: () => void;
}

export function ListingsPage({
  searchFilter = null,
  onClearSearchFilter,
  sourceFilter = null,
  onClearSourceFilter,
}: ListingsPageProps = {}) {
  const [view, setView] = useStored<"table" | "cards">("hs-view", "table", [
    "table",
    "cards",
  ]);
  const [sort, setSort] = useState<SortState>({ key: "score", dir: "desc" });
  const [followUp, setFollowUp] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  // The three feed buckets: Active (not dismissed), Saved (bookmarked, not
  // dismissed), Dismissed (hidden). The buckets read off two per-user id sets
  // (interested + dismissed); the Listing catalogue itself is shared + global.
  const [bucket, setBucket] = useState<Bucket>("active");
  // The dismiss snackbar — { id } of the just-dismissed home, with an Undo.
  const [undo, setUndo] = useState<{ id: string } | null>(null);

  // Saved ("interested") listings are now persisted PER USER on the server (was
  // localStorage hs-interested) so they survive across devices + sessions. Seed
  // the local optimistic set once from the server, then toggle optimistically +
  // persist via save/unsave. interestedRows still intersects with the loaded
  // page (same behaviour as before — only loaded homes can be drafted).
  const utils = trpc.useUtils();
  const { data: savedRows } = trpc.listings.saved.useQuery();
  const saveMut = trpc.listings.save.useMutation();
  const unsaveMut = trpc.listings.unsave.useMutation();
  const [interested, setInterested] = useState<string[]>([]);
  const seeded = useRef(false);
  useEffect(() => {
    if (!seeded.current && savedRows) {
      setInterested(savedRows.map((r) => r.id));
      seeded.current = true;
    }
  }, [savedRows]);

  function toggleInterest(id: string) {
    const on = interested.includes(id);
    setInterested((s) => (on ? s.filter((x) => x !== id) : [...s, id]));
    const mutation = on ? unsaveMut : saveMut;
    mutation.mutate(
      { listingId: id },
      { onSettled: () => void utils.listings.saved.invalidate() },
    );
  }

  // Dismissed ("hidden") listings — the same per-user server overlay as saved,
  // seeded once from listings.dismissed, then toggled optimistically + persisted
  // via dismiss/restore. A home is hidden, never deleted; restoring brings it
  // back. Dismissing is silent to the agent.
  const { data: dismissedServerRows } = trpc.listings.dismissed.useQuery();
  const dismissMut = trpc.listings.dismiss.useMutation();
  const restoreMut = trpc.listings.restore.useMutation();
  const [dismissed, setDismissed] = useState<string[]>([]);
  const dismissSeeded = useRef(false);
  useEffect(() => {
    if (!dismissSeeded.current && dismissedServerRows) {
      setDismissed(dismissedServerRows.map((r) => r.id));
      dismissSeeded.current = true;
    }
  }, [dismissedServerRows]);

  // Auto-clear the undo snackbar after a few seconds (matches the design).
  useEffect(() => {
    if (!undo) {
      return;
    }
    const t = window.setTimeout(() => setUndo(null), 6000);
    return () => window.clearTimeout(t);
  }, [undo]);

  function dismiss(id: string) {
    setDismissed((s) => (s.includes(id) ? s : [...s, id]));
    setUndo({ id });
    dismissMut.mutate(
      { listingId: id },
      { onSettled: () => void utils.listings.dismissed.invalidate() },
    );
  }

  function restore(id: string) {
    setDismissed((s) => s.filter((x) => x !== id));
    setUndo((u) => (u && u.id === id ? null : u));
    restoreMut.mutate(
      { listingId: id },
      { onSettled: () => void utils.listings.dismissed.invalidate() },
    );
  }

  function toggleDismiss(id: string) {
    if (dismissed.includes(id)) {
      restore(id);
    } else {
      dismiss(id);
    }
  }

  // Clear the SHOWN interested homes — locally AND on the server (so a reload
  // does not resurrect them). Scoped to the ids the interest-bar actually counts
  // (the loaded/filtered page), so Clear matches the visible count and never
  // silently unsaves off-page bookmarks the user can't see. Used by the bar's
  // "Clear" + after a follow-up send (both operate on the shown interestedRows).
  function clearShownInterest(shownIds: string[]) {
    const shown = new Set(shownIds);
    setInterested((s) => s.filter((id) => !shown.has(id)));
    for (const id of shownIds) {
      unsaveMut.mutate({ listingId: id });
    }
    void utils.listings.saved.invalidate();
  }

  // No manual filters: fetch the page ordered by match score (server attaches
  // each row's combinedScore) and re-sort client-side on header/dropdown
  // change. Two mutually-exclusive drill-ins can scope the page: a SEARCH filter
  // (a search's "View homes" → scoped to its outcodes + a per-search scoring
  // lens) or a SOURCE filter (a source's "View N lots" → scoped to its
  // primarySource). App clears the other before navigating, so at most one is
  // ever set; build ONE filter object via if/else so neither clobbers the
  // other's `filter` key.
  const listQueryInput = useMemo(() => {
    if (sourceFilter) {
      return {
        filter: { source: sourceFilter.id },
        sortBy: "combinedScore" as const,
        sortDir: "desc" as const,
        limit: 100,
      };
    }
    if (searchFilter) {
      return {
        ...(searchFilter.outcodes.length > 0
          ? { filter: { outcodes: searchFilter.outcodes } }
          : {}),
        // Per-search scoring lens: the Match ring + score sort reflect THAT
        // search's taste (else the best across all the operator's searches).
        searchId: searchFilter.id,
        sortBy: "combinedScore" as const,
        sortDir: "desc" as const,
        limit: 100,
      };
    }
    return {
      sortBy: "combinedScore" as const,
      sortDir: "desc" as const,
      limit: 100,
    };
  }, [searchFilter, sourceFilter]);

  const { data, isLoading, isError, refetch } =
    trpc.listings.list.useQuery(listQueryInput);

  // Recompute "now" only when the data changes, so relative times + age sort
  // keys are stable across re-sorts within the same fetched page.
  const now = useMemo(() => new Date(), [data]);

  // The Active feed is the score-ordered LIST page (top matches). The Saved +
  // Dismissed buckets, by contrast, draw from the FULL per-user overlays
  // (listings.saved / listings.dismissed) so a bookmarked or hidden home is
  // reachable even when it falls outside the top-100 page — otherwise a dismissed
  // home could never be restored. A unified id→row lookup merges all three
  // sources (the page WINS for in-page homes so optimistic toggles show
  // instantly; the overlays supply rows for homes outside the page).
  const pageRows = useMemo(
    () => (data?.items ?? []).map((item) => toViewRow(item, now)),
    [data, now],
  );
  const savedViewRows = useMemo(
    () => (savedRows ?? []).map((item) => toViewRow(item, now)),
    [savedRows, now],
  );
  const dismissedViewRows = useMemo(
    () => (dismissedServerRows ?? []).map((item) => toViewRow(item, now)),
    [dismissedServerRows, now],
  );
  const byId = useMemo(() => {
    const m = new Map<string, ViewRow>();
    for (const r of savedViewRows) m.set(r.id, r);
    for (const r of dismissedViewRows) m.set(r.id, r);
    for (const r of pageRows) m.set(r.id, r); // page last → wins for in-page homes
    return m;
  }, [pageRows, savedViewRows, dismissedViewRows]);

  // Bucket counts: Active = page minus dismissed; Saved = bookmarked AND not
  // dismissed (full overlay); Dismissed = the full hidden overlay.
  const counts = useMemo(
    () => ({
      active: pageRows.filter((l) => !dismissed.includes(l.id)).length,
      saved: interested.filter((id) => !dismissed.includes(id) && byId.has(id)).length,
      dismissed: dismissed.filter((id) => byId.has(id)).length,
    }),
    [pageRows, interested, dismissed, byId],
  );

  // The rows the current bucket renders, sorted by the active sort.
  const displayRows = useMemo(() => {
    const sortRows = (rs: ViewRow[]) =>
      [...rs].sort((a, b) => compare(a, b, sort.key, sort.dir));
    const hydrate = (ids: string[]) =>
      ids
        .map((id) => byId.get(id))
        .filter((r): r is ViewRow => r !== undefined);
    if (bucket === "saved") {
      return sortRows(hydrate(interested.filter((id) => !dismissed.includes(id))));
    }
    if (bucket === "dismissed") {
      return sortRows(hydrate(dismissed));
    }
    return sortRows(pageRows.filter((l) => !dismissed.includes(l.id)));
  }, [bucket, pageRows, interested, dismissed, byId, sort]);

  // The map modal plots the CURRENT bucket's rows; project to its lean shape.
  const mapRows = useMemo<MapListing[]>(
    () =>
      displayRows.map((r) => ({
        id: r.id,
        address: r.address,
        postcode: r.postcode,
        price: r.price,
        bedrooms: r.bedrooms,
        bathrooms: r.bathrooms,
        score: r.score,
        listingUrl: r.listingUrl,
      })),
    [displayRows],
  );

  function onSort(key: SortKey) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: SORTS[key].dir },
    );
  }

  // The follow-up bar drafts the bookmarked (not-dismissed) homes — drawn from
  // the full saved overlay so an off-page bookmark still counts; a dismissed home
  // drops out (its bookmark persists, so restoring returns it to Saved).
  const interestedRows = useMemo(
    () =>
      interested
        .filter((id) => !dismissed.includes(id))
        .map((id) => byId.get(id))
        .filter((r): r is ViewRow => r !== undefined),
    [interested, dismissed, byId],
  );

  const hasMore = Boolean(data?.nextCursor);

  return (
    <main>
      <h1 className="sr-only">Listings</h1>

      {searchFilter && (
        <div className="search-filter" data-testid="search-filter-banner">
          <div className="sf-left">
            <span className="sf-eyebrow">
              <Icon name="search" size={13} /> Search
            </span>
            <span className="sf-name">{searchFilter.name}</span>
            {searchFilter.outcodes.length > 0 && (
              <span className="sf-outcodes">
                {searchFilter.outcodes.map((oc) => (
                  <span key={oc} className="sf-oc">
                    {oc}
                  </span>
                ))}
              </span>
            )}
            <span
              className={`sf-status sf-status--${
                searchFilter.status === "active" ? "active" : "paused"
              }`}
            >
              <Icon name={searchFilter.status === "active" ? "play" : "pause"} size={11} />
              {searchFilter.status === "active" ? "Active" : "Paused"}
            </span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            data-testid="search-filter-clear"
            onClick={() => onClearSearchFilter?.()}
          >
            All listings
          </Button>
        </div>
      )}

      {sourceFilter && (
        <div
          className="search-filter source-filter"
          data-testid="source-filter-banner"
        >
          <div className="sf-left">
            <span className="sf-eyebrow">
              <Icon
                name={sourceFilter.kind === "auction" ? "gavel" : "trees"}
                size={13}
              />{" "}
              Source
            </span>
            <span className="sf-name">{sourceFilter.name}</span>
            <a
              className="sf-visit"
              href={`https://${sourceFilter.domain}`}
              target="_blank"
              rel="noreferrer"
            >
              {sourceFilter.domain}
              <Icon name="external-link" size={13} />
            </a>
          </div>
          <Button
            variant="secondary"
            size="sm"
            data-testid="source-filter-clear"
            onClick={() => onClearSourceFilter?.()}
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
            <span className="ctrl-left">
              <span className="count" data-testid="listings-count">
                <b>
                  {pageRows.length}
                  {hasMore ? "+" : ""}
                </b>{" "}
                {sourceFilter
                  ? `${pageRows.length === 1 ? "listing" : "listings"} from ${sourceFilter.name}`
                  : `${pageRows.length === 1 ? "home" : "homes"} from your agents`}
              </span>
              <InfoTip label="About listings">
                {sourceFilter
                  ? "Listings crawled from this source on a schedule and scored against your taste. Click a listing to open it on the source site; bookmark the ones you like or dismiss the ones you don't to tune your scoring."
                  : "Homes your agents have sent in, read from their emails and scored against your taste. Click a home to open the agent's page; bookmark the ones you like to draft a follow-up to their agency, or dismiss the ones you don't to tune your scoring."}
              </InfoTip>
            </span>
            <div className="statusfilter" role="group" aria-label="Filter listings">
              {BUCKETS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className={`sf-chip${bucket === b.id ? " is-on" : ""}`}
                  data-testid={`bucket-${b.id}`}
                  aria-pressed={bucket === b.id}
                  onClick={() => setBucket(b.id)}
                >
                  {b.label} <span className="sf-chip__n">{counts[b.id]}</span>
                </button>
              ))}
            </div>
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
                <button
                  type="button"
                  data-testid="view-map"
                  onClick={() => setMapOpen(true)}
                  disabled={displayRows.length === 0}
                  aria-label="Map view"
                  title="See these homes on a map"
                >
                  <Icon name="map-pin" size={17} />
                </button>
              </div>
            </div>
          </div>

          {displayRows.length === 0 ? (
            <div className="empty" data-testid="listings-empty">
              <Photo style={{ aspectRatio: "1" }} />
              <p>
                {bucket === "saved"
                  ? "No saved homes yet — bookmark ones you like to gather them here."
                  : bucket === "dismissed"
                    ? "Nothing dismissed. Homes you hide land here, and you can restore them any time."
                    : sourceFilter
                      ? `No listings from ${sourceFilter.name} yet — it's being crawled on a schedule; listings appear here as they're found.`
                      : "No listings yet. Once your agents reply, the homes they send appear here."}
              </p>
            </div>
          ) : view === "table" ? (
            <ListingsTable
              rows={displayRows}
              sort={sort}
              onSort={onSort}
              interested={interested}
              onToggleInterest={toggleInterest}
              dismissed={dismissed}
              onToggleDismiss={toggleDismiss}
            />
          ) : (
            <div className="grid-cards">
              {displayRows.map((l) => (
                <ListingCard
                  key={l.id}
                  row={l}
                  interested={interested.includes(l.id)}
                  onToggleInterest={() => toggleInterest(l.id)}
                  dismissed={dismissed.includes(l.id)}
                  onToggleDismiss={() => toggleDismiss(l.id)}
                />
              ))}
            </div>
          )}

          <div className="foot-note">
            <Icon name="shield-check" size={14} />
            {bucket === "dismissed"
              ? "Dismissed homes are hidden from your feed and help tune your scoring — nothing is sent to the agent. Restore any time."
              : "Bookmark homes you like to follow up · dismiss the ones you don’t to tune your scoring, silently — never to the agent."}
          </div>

          {interestedRows.length > 0 && (
            <InterestBar
              count={interestedRows.length}
              onReview={() => setFollowUp(true)}
              onClear={() =>
                clearShownInterest(interestedRows.map((l) => l.id))
              }
            />
          )}

          {undo &&
            (() => {
              const home = byId.get(undo.id);
              return (
                <div className="toast" role="status" data-testid="dismiss-toast">
                  <span className="toast__msg">
                    <Icon name="eye-off" size={15} />
                    Dismissed{home ? ` ${home.address}` : ""}
                  </span>
                  <button
                    type="button"
                    className="toast__action"
                    data-testid="dismiss-undo"
                    onClick={() => restore(undo.id)}
                  >
                    Undo
                  </button>
                </div>
              );
            })()}

          {followUp && interestedRows.length > 0 && (
            <FollowUpModal
              rows={interestedRows}
              onClose={() => setFollowUp(false)}
              onSent={() => {
                clearShownInterest(interestedRows.map((l) => l.id));
                setFollowUp(false);
              }}
            />
          )}

          {mapOpen && (
            <Suspense fallback={null}>
              <MapModal
                rows={mapRows}
                areaLabel={searchFilter ? searchFilter.name : null}
                interested={interested}
                onToggleInterest={toggleInterest}
                onClose={() => setMapOpen(false)}
              />
            </Suspense>
          )}
        </>
      )}
    </main>
  );
}
