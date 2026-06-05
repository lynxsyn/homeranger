/* global React, Icon, Button, Chip, AGENT_STATUS, listingsForAgency, searchOutcodes, coverageFor, coverageSummary, placeFor */
const { useState: useAgState, useMemo: useAgMemo, useRef: useAgRef, useEffect: useAgEffect } = React;

/* ---- Coverage cell --------------------------------------------------------
   Postcode letters don't describe a place — a county does. A wide patch rolls
   up to its dominant county/region plus a count ("Gwynedd · 5 outcodes"), one
   fixed-height line. The popover breaks it down by town, HQ marked. A single-
   outcode agent reads as its town + outcode, no popover. */
function CoverageCell({ agent }) {
  const [open, setOpen] = useAgState(false);
  const [pos, setPos] = useAgState(null);   // fixed-position rect for the portal popover
  const wrap = useAgRef(null);
  const popRef = useAgRef(null);
  const triggerRef = useAgRef(null);
  const coverage = agent.coverage && agent.coverage.length
    ? agent.coverage
    : coverageFor(agent.agencyName, agent.outcode);
  const s = useAgMemo(() => coverageSummary(coverage), [coverage]);

  function place() {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 12;
    const spaceBelow = window.innerHeight - r.bottom - margin;
    const spaceAbove = r.top - margin;
    const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(160, (openUp ? spaceAbove : spaceBelow));
    setPos({
      left: r.left,
      top: openUp ? null : r.bottom + 6,
      bottom: openUp ? window.innerHeight - r.top + 6 : null,
      maxHeight,
    });
  }

  useAgEffect(() => {
    if (!open) return;
    place();
    const onDoc = (e) => {
      if (wrap.current && wrap.current.contains(e.target)) return;
      if (popRef.current && popRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
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

  // One outcode — show its town + the code, no rollup needed.
  if (s.count <= 1) {
    return (
      <div className="cov-cell">
        <span className="cov-static">
          <Icon name="map-pin" size={13} />
          <span className="cov-static__town">{s.primaryTown}</span>
          {s.primary && <span className="sf-oc">{s.primary}</span>}
        </span>
        <span className="cov-search">{agent.searchName}</span>
      </div>
    );
  }

  const popover = open && pos ? ReactDOM.createPortal(
    <div
      className="cov-pop"
      role="dialog"
      aria-label="Coverage detail"
      ref={popRef}
      style={{ left: pos.left, top: pos.top ?? "auto", bottom: pos.bottom ?? "auto", maxHeight: pos.maxHeight }}
    >
      <div className="cov-pop__head">
        Covers <b>{s.count} outcodes</b> around {s.regions.join(", ")}
      </div>
      <div className="cov-pop__groups">
        {s.towns.map((town) => (
          <div className="cov-grp" key={town}>
            <span className="cov-grp__area">{town}</span>
            <div className="cov-grp__chips">
              {s.groups[town].map((oc) => (
                <span key={oc} className={`sf-oc${oc === s.primary ? " is-primary" : ""}`}>
                  {oc === s.primary && <i className="cov-hq" aria-hidden="true" />}
                  {oc}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="cov-pop__foot">
        <i className="cov-hq" aria-hidden="true" /> Head office · {s.primaryTown} ({s.primary})
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <div className="cov-cell cov-cell--roll" ref={wrap}>
      <button
        type="button"
        ref={triggerRef}
        className={`cov-roll${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-label={`Coverage: ${s.count} outcodes around ${s.region}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="map-pin" size={13} />
        <span className="cov-roll__area">{s.region}</span>
        <span className="cov-roll__sep" aria-hidden="true">·</span>
        <span className="cov-roll__count">{s.count} outcodes</span>
        <Icon name="chevron-down" size={13} />
      </button>
      <span className="cov-search">{agent.searchName}</span>
      {popover}
    </div>
  );
}

/* ---- Row actions menu (portaled so the table's overflow can't clip it) ----
   One destructive action today (Remove), but built as a menu so it can grow. */
function RowActions({ agent, onAskRemove }) {
  const [open, setOpen] = useAgState(false);
  const [pos, setPos] = useAgState(null);
  const wrap = useAgRef(null);
  const popRef = useAgRef(null);
  const btnRef = useAgRef(null);

  function place() {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const menuW = 184;
    const below = window.innerHeight - r.bottom;
    const openUp = below < 120 && r.top > below;
    setPos({
      left: Math.max(12, r.right - menuW),
      top: openUp ? null : r.bottom + 6,
      bottom: openUp ? window.innerHeight - r.top + 6 : null,
    });
  }

  useAgEffect(() => {
    if (!open) return;
    place();
    const onDoc = (e) => {
      if (wrap.current && wrap.current.contains(e.target)) return;
      if (popRef.current && popRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
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

  const menu = open && pos ? ReactDOM.createPortal(
    <div className="rowmenu" role="menu" ref={popRef}
      style={{ left: pos.left, top: pos.top ?? "auto", bottom: pos.bottom ?? "auto" }}>
      <button type="button" role="menuitem" className="rowmenu__item rowmenu__item--danger"
        onClick={() => { setOpen(false); onAskRemove(agent); }}>
        <Icon name="trash-2" size={16} /> Remove from list
      </button>
    </div>,
    document.body,
  ) : null;

  return (
    <div className="rowactions" ref={wrap}>
      <button type="button" ref={btnRef}
        className={`rowactions__btn${open ? " is-open" : ""}`}
        aria-label={`Actions for ${agent.agencyName}`} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        <Icon name="more-horizontal" size={18} />
      </button>
      {menu}
    </div>
  );
}

/* ---- Remove confirmation --------------------------------------------------
   Removing an agent is consequential (it affects outreach + your metrics), so
   unlike hiding a listing it asks first, in the candid HomeRanger voice. */
function ConfirmRemove({ agent, homes, onCancel, onConfirm }) {
  useAgEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="modal-scrim" onMouseDown={onCancel}>
      <div className="modal modal--confirm" role="dialog" aria-modal="true" aria-label="Remove agent"
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="confirm-body">
          <div className="confirm-mark confirm-mark--danger"><Icon name="trash-2" size={22} /></div>
          <h2 className="confirm-title">Remove {agent.agencyName}?</h2>
          <p className="confirm-text">
            They&rsquo;ll drop off your agents list and out of your metrics, and HomeRanger won&rsquo;t
            contact them again unless a future search finds them and you approve it.
            {homes > 0
              ? ` The ${homes} ${homes === 1 ? "home" : "homes"} they’ve already sent in ${homes === 1 ? "stays" : "stay"} in your listings.`
              : " Anything they’ve already sent in stays in your listings."}
          </p>
        </div>
        <div className="modal__foot modal__foot--end">
          <Button variant="secondary" onClick={onCancel}>Keep agent</Button>
          <Button variant="danger" icon="trash-2" onClick={onConfirm}>Remove</Button>
        </div>
      </div>
    </div>
  );
}

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
function AgentsScreen({ agents, sending, onToggleSending, filter, onClearFilter, onViewHomes, onRemoveAgent }) {
  const [statusFilter, setStatusFilter] = useAgState("all");
  const [removing, setRemoving] = useAgState(null);

  // Patch filter: agents whose outcode falls in the chosen search's patch.
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
        <div className="search-filter">
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
                <th className="col-act" aria-label="Actions"></th>
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
                      <CoverageCell agent={a} />
                    </td>
                    <td><ThreadStatus status={a.status} /></td>
                    <td className="num col-homes">
                      {homes > 0
                        ? <span className="homes-cell"><Icon name="home" size={14} />{homes}</span>
                        : <span className="homes-cell na">—</span>}
                    </td>
                    <td className="num col-seen"><span className="seen-cell">{a.lastContact}</span></td>
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
        Agents are contacted only after you approve them in a launch — corporate subscribers, never opted-out, within the warm-up cap
      </div>

      {removing && (
        <ConfirmRemove
          agent={removing}
          homes={listingsForAgency(removing.agencyName)}
          onCancel={() => setRemoving(null)}
          onConfirm={() => { onRemoveAgent(removing.id); setRemoving(null); }}
        />
      )}
    </div>
  );
}

Object.assign(window, { AgentsScreen, OutreachStatus });
