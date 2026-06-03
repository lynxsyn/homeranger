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
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@homeranger/backend-core";
import { trpc } from "../lib/trpc";
import { Icon } from "../components/Icon";
import { Button } from "../components/ui";
import { InfoTip } from "../components/InfoTip";
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

/* ---- Screen --------------------------------------------------------------- */
export interface AgentsPageProps {
  /** When set, the list is scoped to a search's outcodes + a banner is shown. */
  filter: AgentFilter | null;
  /** Clear the drill-in filter (the banner's "All agents" action). */
  onClearFilter: () => void;
}

export function AgentsPage({ filter, onClearFilter }: AgentsPageProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

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
                    <th scope="col">Status</th>
                    <th scope="col" className="num col-homes">
                      Homes
                    </th>
                    <th scope="col" className="num col-seen">
                      Last contact
                    </th>
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
                          <div className="cov-cell">
                            {a.outcodes.map((oc) => (
                              <span key={oc} className="sf-oc">
                                {oc}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td>
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
    </main>
  );
}
