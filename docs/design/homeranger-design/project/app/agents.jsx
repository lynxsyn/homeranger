/* global React, Icon, Button, Chip, AGENT_STATUS, listingsForAgency, scoutOutcodes */
const { useState: useAgState, useMemo: useAgMemo } = React;

/* ---- Outreach sending control (the de-crunched kill-switch) --------------
   The global panic-stop, given room to read. `sending` true = live; toggling
   to paused models WarmupState.killSwitch ON — no approved send leaves the
   building until it's flipped back. Used on both Searches and Agents. */
function OutreachStatus({ sending, onToggle, warmup }) {
  const w = warmup || { today: 22, cap: 35 };
  const pct = Math.min(100, Math.round((w.today / w.cap) * 100));
  return (
    <div className={`outreach-bar${sending ? "" : " is-paused"}`}>
      <span className="ob-icon"><Icon name={sending ? "radar" : "power"} size={20} /></span>
      <div className="ob-copy">
        <span className="ob-title">
          {sending ? "Outreach is sending live" : "Outreach paused"}
          <span className="ob-pulse" aria-hidden="true" />
          <InfoTip label="What outreach sending means">
            <b>The global send switch.</b> When live, the emails you approve in a launch actually go out to agents — paced under today’s warm-up cap, and only to ones that pass the ComplianceGuard. Pause to stop all outbound email at once; replies still come in and still become listings.
          </InfoTip>
        </span>
      </div>
      <div className="ob-right">
        {sending && (
          <div className="ob-warmup" title={`${w.today} of ${w.cap} sent today`}>
            <span className="obw-head">
              <Icon name="trending-up" size={13} /> Warm-up · today
              <InfoTip label="What the warm-up cap means" align="right">
                <b>Daily send cap.</b> A limit on how many agents HomeRanger emails per day, raised gradually to protect deliverability. Today’s approved sends count against it.
              </InfoTip>
            </span>
            <span className="obw-bar"><i style={{ width: `${pct}%` }} /></span>
            <span className="obw-num">{w.today} / {w.cap}</span>
          </div>
        )}
        <button
          type="button"
          className={`killswitch__toggle${sending ? "" : " is-on"}`}
          role="switch"
          aria-checked={!sending}
          aria-label={sending ? "Pause all outreach" : "Resume all outreach"}
          onClick={onToggle}
        >
          <span className="killswitch__knob" />
        </button>
      </div>
    </div>
  );
}

/* ---- Agency monogram ------------------------------------------------------ */
function AgentMark({ name }) {
  const initials = (name || "")
    .split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join("");
  return <span className="agent-mark" aria-hidden="true">{initials || "?"}</span>;
}

/* ---- Status pill ---------------------------------------------------------- */
function ThreadStatus({ status }) {
  const m = AGENT_STATUS[status] || AGENT_STATUS.awaiting;
  return (
    <span className={`thread-status thread-status--${m.cls}`}>
      {m.dot && <i className="ts-dot" aria-hidden="true" />}
      {m.label}
    </span>
  );
}

/* ---- A small headline metric ---------------------------------------------- */
function AgentMetric({ icon, value, label }) {
  return (
    <div className="ag-metric">
      <span className="agm-ic"><Icon name={icon} size={16} /></span>
      <span className="agm-val">{value}</span>
      <span className="agm-label">{label}</span>
    </div>
  );
}

const AGENT_FILTERS = [
  { id: "all", label: "All" },
  { id: "replied", label: "Replied" },
  { id: "awaiting", label: "Awaiting" },
  { id: "opted_out", label: "Opted out" },
];

/* ---- Screen --------------------------------------------------------------- */
function AgentsScreen({ agents, sending, onToggleSending, filter, onClearFilter, onViewHomes }) {
  const [statusFilter, setStatusFilter] = useAgState("all");

  // Patch filter: agents whose outcode falls in the chosen scout's patch.
  const inPatch = useAgMemo(() => {
    if (!filter) return agents;
    const set = (filter.outcodes || []).map((o) => o.toUpperCase());
    if (!set.length) return agents;
    return agents.filter((a) => set.includes((a.outcode || "").toUpperCase()));
  }, [agents, filter]);

  const rows = useAgMemo(() => {
    let base = inPatch;
    if (statusFilter === "awaiting") base = base.filter((a) => a.status === "awaiting" || a.status === "queued");
    else if (statusFilter !== "all") base = base.filter((a) => a.status === statusFilter);
    const order = { replied: 0, awaiting: 1, queued: 1, opted_out: 2 };
    return [...base].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));
  }, [inPatch, statusFilter]);

  // Metrics over the current patch (independent of the status chip).
  const metrics = useAgMemo(() => {
    const replied = inPatch.filter((a) => a.status === "replied").length;
    const awaiting = inPatch.filter((a) => a.status === "awaiting" || a.status === "queued").length;
    const agencySet = new Set(inPatch.map((a) => a.agencyName));
    let homes = 0;
    (window.LISTINGS || []).forEach((l) => { if (agencySet.has(l.agency)) homes += 1; });
    return { contacted: inPatch.length, replied, awaiting, homes };
  }, [inPatch]);

  return (
    <div>
      {filter && (
        <div className="scout-filter">
          <div className="sf-left">
            <span className="sf-eyebrow"><Icon name="search" size={13} /> Search</span>
            <div className="sf-name">{filter.name}</div>
            {filter.outcodes && filter.outcodes.length > 0 && (
              <div className="sf-outcodes">
                {filter.outcodes.map((o) => <span key={o} className="sf-oc">{o}</span>)}
              </div>
            )}
          </div>
          <button className="hs-btn hs-btn--secondary hs-btn--sm" onClick={onClearFilter}>
            <Icon name="x" size={15} /> All agents
          </button>
        </div>
      )}

      <div className="ag-metrics">
        <AgentMetric icon="send" value={metrics.contacted} label="Contacted" />
        <AgentMetric icon="inbox" value={metrics.replied} label="Replied" />
        <AgentMetric icon="mail" value={metrics.awaiting} label="Awaiting reply" />
        <AgentMetric icon="home" value={metrics.homes} label="Homes ingested" />
      </div>

      <div className="controls">
        <div className="statusfilter" role="group" aria-label="Filter by status">
          {AGENT_FILTERS.map((f) => (
            <button key={f.id} className={`sf-chip${statusFilter === f.id ? " is-on" : ""}`}
              aria-pressed={statusFilter === f.id} onClick={() => setStatusFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <span className="ctrl-left">
          <span className="count">
            <b>{rows.length}</b> {rows.length === 1 ? "agent" : "agents"}
          </span>
          <InfoTip label="About agents" align="right" size={14}>
            <b>Your contacted agents.</b> Everyone HomeRanger pulled from a search and contacted, gated by the ComplianceGuard. Their replies become listings.
          </InfoTip>
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <div className="empty-mark"><Icon name="mail" size={26} /></div>
          <p>{filter ? "No agents contacted in this patch yet — launch the search to find them." : "No agents yet. Launch a search to find and contact local agents."}</p>
        </div>
      ) : (
        <div className="tablewrap">
          <table className="listings agents-table">
            <thead>
              <tr>
                <th>Agency</th>
                <th className="col-cov">Coverage</th>
                <th>Status</th>
                <th className="num col-homes">Homes</th>
                <th className="num col-seen">Last contact</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const homes = listingsForAgency(a.agencyName);
                return (
                  <tr key={a.id} className="row">
                    <td>
                      <div className="cell-agent">
                        <AgentMark name={a.agencyName} />
                        <span className="at">
                          <b>{a.agencyName}</b>
                          <small>{a.email}</small>
                        </span>
                      </div>
                    </td>
                    <td className="col-cov">
                      <div className="cov-cell">
                        {a.outcode && <span className="sf-oc">{a.outcode}</span>}
                        <span className="cov-scout">{a.scoutName}</span>
                      </div>
                    </td>
                    <td><ThreadStatus status={a.status} /></td>
                    <td className="num col-homes">
                      {homes > 0
                        ? <span className="homes-cell"><Icon name="home" size={14} />{homes}</span>
                        : <span className="homes-cell na">—</span>}
                    </td>
                    <td className="num col-seen"><span className="seen-cell">{a.lastContact}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="foot-note">
        <Icon name="shield-check" size={14} />
        Agents are contacted only after you approve them in a launch — corporate subscribers, never opted-out, within the warm-up cap
      </div>
    </div>
  );
}

Object.assign(window, { AgentsScreen, OutreachStatus });
