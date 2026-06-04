/**
 * AgentsPage — the HomeRanger Agents screen, a faithful port of the
 * claude.ai/design handoff (project/app/agents.jsx) onto real tRPC data.
 *
 * An "agent" here is a real estate AGENT/agency HomeRanger discovered while
 * working a search and then contacted, enriched with the latest outreach-thread
 * status and a count of the homes it has sent in. The screen is operator-only
 * (the discovered-agent pool + outreach state is global, not per-user), so it
 * only appears as a top-bar tab for operators; the backend also enforces this.
 *
 * A search's "View agents" link sets a drill-in filter (the search's name +
 * outcodes) and routes here; the banner mirrors the Listings search-filter
 * banner so the two drill-ins read the same. The four metric tiles come straight
 * from `agents.stats` (kept consistent with `agents.list` server-side); the
 * status-filter chips + sort are client-side over the fetched rows.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@homeranger/backend-core";
import { trpc } from "../lib/trpc";
import { Icon } from "../components/Icon";
import { Button } from "../components/ui";
import { InfoTip } from "../components/InfoTip";
import { CoverageCell } from "../components/CoverageCell";
import { relativeTime } from "../lib/format";

type AgentRow = inferRouterOutputs<AppRouter>["agents"]["list"][number];
type AgentStats = inferRouterOutputs<AppRouter>["agents"]["stats"];
type AgentThreadStatus = AgentRow["status"];

/** A search drill-in: the agents scoped to one search's name + outcodes. */
export interface AgentFilter {
  name: string;
  outcodes: string[];
}

/* ---- Status pill ---------------------------------------------------------- */
/** Visual contract for each derived thread status (label, CSS modifier, dot).
 *  The `opted_out` status maps to the `opted` CSS modifier per the design. */
const STATUS_META: Record<
  AgentThreadStatus,
  { label: string; cls: string; dot: boolean }
> = {
  replied: { label: "Replied", cls: "replied", dot: true },
  awaiting: { label: "Awaiting reply", cls: "awaiting", dot: true },
  queued: { label: "Queued", cls: "queued", dot: false },
  opted_out: { label: "Opted out", cls: "opted", dot: true },
};

function ThreadStatus({ status }: { status: AgentThreadStatus }) {
  const m = STATUS_META[status] ?? STATUS_META.awaiting;
  return (
    <span className={`thread-status thread-status--${m.cls}`}>
      {m.dot && <i className="ts-dot" aria-hidden="true" />}
      {m.label}
    </span>
  );
}

/* ---- Agency monogram ------------------------------------------------------ */
/** Up to two initials from the agency name (or email when unnamed). */
function AgentMark({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <span className="agent-mark" aria-hidden="true">
      {initials || "?"}
    </span>
  );
}

/* ---- Headline metric tile ------------------------------------------------- */
interface AgentMetricProps {
  icon: string;
  value: ReactNode;
  label: string;
  testid: string;
}

function AgentMetric({ icon, value, label, testid }: AgentMetricProps) {
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

/* ---- Status filter chips -------------------------------------------------- */
type StatusFilter = "all" | "replied" | "awaiting" | "opted_out";

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "replied", label: "Replied" },
  { id: "awaiting", label: "Awaiting" },
  { id: "opted_out", label: "Opted out" },
];

/** Display name for an agent — the agency, falling back to its email. */
function agentName(row: AgentRow): string {
  return row.agencyName ?? row.email;
}

/** Sort weight: replied first, then awaiting/queued, then opted-out. */
const SORT_WEIGHT: Record<AgentThreadStatus, number> = {
  replied: 0,
  awaiting: 1,
  queued: 1,
  opted_out: 2,
};

/* ---- Row actions menu -----------------------------------------------------
 * Portaled (the agents table's .tablewrap is overflow:hidden, which would clip
 * an inline popover — same reason CoverageCell portals). One destructive action
 * today (Remove), built as a menu so it can grow. */
interface RowActionsProps {
  agent: AgentRow;
  onAskRemove: (agent: AgentRow) => void;
}

function RowActions({ agent, onAskRemove }: RowActionsProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const place = () => {
      const el = btnRef.current;
      if (!el) {
        return;
      }
      const r = el.getBoundingClientRect();
      const menuW = 188;
      setPos({ left: Math.max(12, r.right - menuW), top: r.bottom + 6 });
    };
    place();
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrap.current?.contains(t) || popRef.current?.contains(t)) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const menu =
    open && pos
      ? createPortal(
          <div
            className="rowmenu"
            role="menu"
            ref={popRef}
            data-testid="agent-menu"
            style={{ left: pos.left, top: pos.top }}
          >
            <button
              type="button"
              role="menuitem"
              className="rowmenu__item rowmenu__item--danger"
              data-testid="agent-remove"
              onClick={() => {
                setOpen(false);
                onAskRemove(agent);
              }}
            >
              <Icon name="trash-2" size={16} /> Remove from list
            </button>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="rowactions" ref={wrap}>
      <button
        type="button"
        ref={btnRef}
        className={`rowactions__btn${open ? " is-open" : ""}`}
        data-testid="agent-actions"
        aria-label={`Actions for ${agentName(agent)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon name="more-horizontal" size={18} />
      </button>
      {menu}
    </div>
  );
}

/* ---- Remove confirmation --------------------------------------------------
 * Removing an agent is consequential + irreversible (it ERASES the agency and
 * all its correspondence — GDPR), so unlike hiding a listing it asks first, in
 * the candid HomeRanger voice. The homes it already sent STAY in your listings. */
interface ConfirmRemoveProps {
  agent: AgentRow;
  removing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmRemove({ agent, removing, onCancel, onConfirm }: ConfirmRemoveProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onCancel]);

  const name = agentName(agent);
  const homes = agent.homesCount;
  return (
    <div className="modal-scrim" onMouseDown={onCancel}>
      <div
        className="modal modal--confirm"
        role="dialog"
        aria-modal="true"
        aria-label="Remove agent"
        data-testid="agent-remove-confirm"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="confirm-body">
          <div className="confirm-mark confirm-mark--danger">
            <Icon name="trash-2" size={22} />
          </div>
          <h2 className="confirm-title">Remove {name}?</h2>
          <p className="confirm-text">
            This permanently removes <b>{name}</b> and every message exchanged
            with them. They drop off your agents list and out of your metrics, and
            HomeRanger won&rsquo;t contact them again unless a future search finds
            them and you approve it.{" "}
            {homes > 0
              ? `The ${homes} ${homes === 1 ? "home" : "homes"} they’ve already sent in ${homes === 1 ? "stays" : "stay"} in your listings.`
              : "Anything they’ve already sent in stays in your listings."}
          </p>
        </div>
        <div className="modal__foot modal__foot--end">
          <Button variant="secondary" onClick={onCancel} disabled={removing}>
            Keep agent
          </Button>
          <Button
            variant="danger"
            icon="trash-2"
            data-testid="agent-remove-confirm-btn"
            disabled={removing}
            onClick={onConfirm}
          >
            {removing ? "Removing…" : "Remove"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ---- Screen --------------------------------------------------------------- */
export interface AgentsPageProps {
  /** When set, the list is scoped to a search's outcodes + a banner is shown. */
  filter: AgentFilter | null;
  /** Clear the drill-in filter (the banner's "All agents" action). */
  onClearFilter: () => void;
}

export function AgentsPage({ filter, onClearFilter }: AgentsPageProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // The agent awaiting removal confirmation (null = no dialog open).
  const [removing, setRemoving] = useState<AgentRow | null>(null);

  // Scope both queries to the drill-in's outcodes (absent → all agents); list +
  // stats are built from the same server-side row set so the metrics and the
  // table always agree.
  const outcodes = filter?.outcodes;
  const {
    data: listData,
    isLoading,
    isError,
    refetch,
  } = trpc.agents.list.useQuery({ outcodes });
  const { data: stats } = trpc.agents.stats.useQuery({ outcodes });

  // Complete (GDPR) removal: erase the agent + its threads/messages, then refresh
  // the table AND the metric tiles (both read the same server rows).
  const utils = trpc.useUtils();
  const removeMut = trpc.agents.remove.useMutation({
    onSuccess: () => {
      void utils.agents.list.invalidate();
      void utils.agents.stats.invalidate();
      setRemoving(null);
    },
  });

  const allRows = listData ?? [];

  // Status chip → row filter, then sort by status weight. "Awaiting" folds the
  // queued (first-send-pending) rows in with awaiting-reply, mirroring the
  // metric; "Opted out" is the exact status; "All" is everything.
  const rows = useMemo(() => {
    let base = allRows;
    if (statusFilter === "awaiting") {
      base = base.filter((a) => a.status === "awaiting" || a.status === "queued");
    } else if (statusFilter !== "all") {
      base = base.filter((a) => a.status === statusFilter);
    }
    return [...base].sort(
      (a, b) => (SORT_WEIGHT[a.status] ?? 3) - (SORT_WEIGHT[b.status] ?? 3),
    );
  }, [allRows, statusFilter]);

  const metrics: AgentStats = stats ?? {
    contacted: 0,
    replied: 0,
    awaiting: 0,
    homesIngested: 0,
  };

  return (
    <main>
      <h1 className="sr-only">Agents</h1>

      {filter && (
        <div className="search-filter" data-testid="agent-filter-banner">
          <div className="sf-left">
            <span className="sf-eyebrow">
              <Icon name="search" size={13} /> Search
            </span>
            <span className="sf-name">{filter.name}</span>
            {filter.outcodes.length > 0 && (
              <span className="sf-outcodes">
                {filter.outcodes.map((oc) => (
                  <span key={oc} className="sf-oc">
                    {oc}
                  </span>
                ))}
              </span>
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            data-testid="agent-filter-clear"
            onClick={onClearFilter}
          >
            All agents
          </Button>
        </div>
      )}

      <div className="ag-metrics">
        <AgentMetric
          icon="send"
          value={metrics.contacted}
          label="Contacted"
          testid="agents-metric-contacted"
        />
        <AgentMetric
          icon="inbox"
          value={metrics.replied}
          label="Replied"
          testid="agents-metric-replied"
        />
        <AgentMetric
          icon="mail"
          value={metrics.awaiting}
          label="Awaiting reply"
          testid="agents-metric-awaiting"
        />
        <AgentMetric
          icon="home"
          value={metrics.homesIngested}
          label="Homes ingested"
          testid="agents-metric-homes"
        />
      </div>

      {isError ? (
        <div className="empty" role="alert">
          <p>Couldn&rsquo;t load agents.</p>
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
          <p>Loading agents…</p>
        </div>
      ) : (
        <>
          <div className="controls">
            <div
              className="statusfilter"
              role="group"
              aria-label="Filter by status"
            >
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`sf-chip${statusFilter === f.id ? " is-on" : ""}`}
                  data-testid={`agent-filter-${f.id}`}
                  aria-pressed={statusFilter === f.id}
                  onClick={() => setStatusFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <span className="ctrl-left">
              <span className="count" data-testid="agents-count">
                <b>{rows.length}</b> {rows.length === 1 ? "agent" : "agents"}
              </span>
              <InfoTip label="About agents" align="right" size={14}>
                <b>Your contacted agents.</b> Everyone HomeRanger pulled from a
                search and contacted, gated by the ComplianceGuard. Their replies
                become listings.
              </InfoTip>
            </span>
          </div>

          {rows.length === 0 ? (
            <div className="empty" data-testid="agents-empty">
              <div className="empty-mark">
                <Icon name="mail" size={26} />
              </div>
              <p>
                {filter
                  ? "No agents contacted in this patch yet. Launch the search to find them."
                  : "No agents yet. Launch a search to find and contact local agents."}
              </p>
            </div>
          ) : (
            <div className="tablewrap">
              <table className="listings agents-table" data-testid="agents-table">
                <caption className="sr-only">
                  Estate agents HomeRanger has contacted, with each one&rsquo;s
                  coverage, outreach status, homes sent, and last contact.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Agency</th>
                    <th scope="col" className="col-cov">
                      Coverage
                    </th>
                    <th scope="col" className="col-status">
                      Status
                    </th>
                    <th scope="col" className="num col-homes">
                      Homes
                    </th>
                    <th scope="col" className="num col-seen">
                      Last contact
                    </th>
                    <th scope="col" className="col-act" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => {
                    const name = agentName(a);
                    return (
                      <tr
                        key={a.id}
                        className="row"
                        data-testid="agent-row"
                        data-agency={a.agencyName ?? a.email}
                      >
                        <td>
                          <div className="cell-agent">
                            <AgentMark name={name} />
                            <span className="at">
                              <b>{name}</b>
                              <small>{a.email}</small>
                            </span>
                          </div>
                        </td>
                        <td className="col-cov">
                          <CoverageCell coverage={a.coverage} />
                        </td>
                        <td className="col-status">
                          <ThreadStatus status={a.status} />
                        </td>
                        <td className="num col-homes">
                          {a.homesCount > 0 ? (
                            <span className="homes-cell">
                              <Icon name="home" size={14} />
                              {a.homesCount}
                            </span>
                          ) : (
                            <span className="homes-cell na">—</span>
                          )}
                        </td>
                        <td className="num col-seen">
                          <span className="seen-cell">
                            {a.lastContactedAt
                              ? relativeTime(a.lastContactedAt)
                              : "—"}
                          </span>
                        </td>
                        <td className="col-act">
                          <RowActions agent={a} onAskRemove={setRemoving} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="foot-note">
            <Icon name="shield-check" size={14} />
            Agents are contacted only after you approve them in a launch:
            corporate subscribers, never opted-out, within the warm-up cap
          </div>
        </>
      )}

      {removing && (
        <ConfirmRemove
          agent={removing}
          removing={removeMut.isPending}
          onCancel={() => setRemoving(null)}
          onConfirm={() => removeMut.mutate({ id: removing.id })}
        />
      )}
    </main>
  );
}
