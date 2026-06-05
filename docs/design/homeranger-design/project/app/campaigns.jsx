/* global React, Icon, Button, Chip, CAMPAIGNS, PROPERTY_TYPES */
const { useState, useEffect, useMemo, useRef } = React;

function gbpFull(n) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency", currency: "GBP", maximumFractionDigits: 0,
  }).format(n);
}
function gbpShort(n) {
  if (n == null || n === "") return null;
  const v = Number(n);
  return v >= 1000 ? `£${Math.round(v / 1000)}k` : `£${v}`;
}

/* Templated draft of the email the agent would send — reflects the brief live. */
function draftEmail(c) {
  const loc = (c.location || "your area").split(/[,—]/)[0].trim();
  const typeList = c.types && c.types.length ? c.types.map((t) => t.toLowerCase()) : ["home"];
  const types = typeList.length > 1
    ? typeList.slice(0, -1).join(", ") + " or " + typeList[typeList.length - 1]
    : typeList[0];
  const beds = c.minBeds ? `${c.minBeds}+ bedroom ` : "";
  const price = c.maxPrice ? `, up to ${gbpFull(Number(c.maxPrice))}` : "";
  const taste = (c.keywords || "").trim();
  const condition = c.condition || [];
  const land = c.land || [];
  const sale = c.saleMethods || [];

  // A line about project appetite, when it's a renovation/restoration brief.
  let conditionLine = "";
  if (condition.includes("Restoration project") || condition.includes("Full renovation")) {
    conditionLine = "I'm glad to take on a renovation or full restoration — condition isn't a barrier. ";
  } else if (condition.includes("Some updating")) {
    conditionLine = "Some updating is fine. ";
  }

  // A line about land, only on the terms chosen.
  let landLine = "";
  if (land.length) {
    const parts = [];
    if (land.includes("Land with a building to convert")) parts.push("land with a building to convert, such as a farmhouse or barn");
    if (land.includes("Buildable land or planning potential")) parts.push("a plot with planning permission or genuine potential");
    landLine = `I'd also consider ${parts.join(", or ")}. `;
  }

  const auctionLine = sale.includes("Auction")
    ? "I follow the auction lots too, so do flag anything coming under the hammer. "
    : "";

  const body = (conditionLine + landLine + auctionLine).trim();

  // Pull in the owner's profile so the draft is signed and paced to their urgency.
  const profile = window.getProfile ? window.getProfile() : {};
  const uLine = window.urgencyLine ? window.urgencyLine(profile) : "";
  const signature = window.signatureBlock ? window.signatureBlock(profile) : "Many thanks";
  const closing =
    "If anything coming up fits what I'm after, I'd be glad to hear from you early." +
    (uLine ? ` ${uLine}` : " Happy to move quickly for the right place.");

  return (
    `Hello,\n\n` +
    `I'm a private buyer searching in ${c.location || loc} for a ${beds}${types}${price}.\n\n` +
    (taste ? `In short: ${taste}\n\n` : "") +
    (body ? `${body}\n\n` : "") +
    `${closing}\n\n` +
    `${signature}`
  );
}

/* ---- Status pill (click to pause / resume) ------------------------------- */
function StatusPill({ status, onToggle }) {
  const active = status === "active";
  return (
    <button
      className={`statuspill ${active ? "is-active" : "is-paused"}`}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      title={active ? "Pause this campaign" : "Resume this campaign"}
    >
      <Icon name={active ? "pause" : "play"} size={13} />
      {active ? "Active" : "Paused"}
    </button>
  );
}

/* ---- Campaign card ------------------------------------------------------- */
function CampaignCard({ c, agents, onOpen, onToggle, onViewHomes, onLaunch, onViewAgents }) {
  const found = window.matchSearch(c);
  const codes = window.searchOutcodes(c);
  const canLaunch = codes.length > 0;
  const inPatch = canLaunch ? window.discoverAgents(c).length : 0;
  const contacted = agents.filter((a) => codes.includes((a.outcode || "").toUpperCase())).length;
  return (
    <div className={`hs-card hs-card--interactive campaign-card${c.status === "paused" ? " is-paused" : ""}`}
      onClick={() => onOpen(c)}>
      <div className="cc-main">
        <div className="cc-head">
          <h3 className="cc-name">{c.name}</h3>
          <div className="cc-controls">
            <button type="button" className="sc-launch" disabled={!canLaunch}
              title={canLaunch ? "Launch — find agents and prepare outreach" : "Add a place with target outcodes first"}
              onClick={(e) => { e.stopPropagation(); onLaunch(c); }}>
              <Icon name="rocket" size={14} /> Launch
            </button>
            <StatusPill status={c.status} onToggle={() => onToggle(c.id)} />
            <span className="cc-edit" aria-hidden="true"><Icon name="sliders-horizontal" size={16} /></span>
          </div>
        </div>
        <div className="cc-chips">
          <Chip icon="map-pin">{c.location}</Chip>
          {c.types.map((t) => <Chip key={t} icon="home">{t}</Chip>)}
          {c.minBeds ? <Chip icon="bed-double">{c.minBeds}+ beds</Chip> : null}
          {c.maxPrice ? <Chip>{gbpShort(c.maxPrice)} max</Chip> : null}
          {(c.condition || [])
            .filter((x) => x === "Full renovation" || x === "Restoration project")
            .map((x) => <Chip key={x} accent>{x}</Chip>)}
          {(c.saleMethods || []).includes("Auction") && (
            <span className="listing-tag">Auction</span>
          )}
        </div>
        <p className="cc-keywords">{c.keywords}</p>
      </div>
      <div className="cc-foot">
        {found.length > 0 ? (
          <button className="cc-link" onClick={(e) => { e.stopPropagation(); onViewHomes(c); }}>
            <Icon name="home" size={14} /> {found.length} {found.length === 1 ? "home" : "homes"} found
            <Icon name="arrow-right" size={13} />
          </button>
        ) : (
          <span className="cc-muted"><Icon name="home" size={14} /> No homes yet</span>
        )}
        {canLaunch && (
          <button className="cc-link cc-link--muted" onClick={(e) => { e.stopPropagation(); onViewAgents(c); }}>
            <Icon name="send" size={13} /> <b>{contacted}</b>/{inPatch} agents
            <Icon name="arrow-right" size={13} />
          </button>
        )}
        <span className="cc-spacer" />
        <span className="cc-seen">Last activity {c.lastActivity}</span>
      </div>
    </div>
  );
}

/* ---- Editor modal -------------------------------------------------------- */
const BLANK = {
  name: "", location: "", types: [], condition: [], land: [], saleMethods: ["Private treaty"],
  minBeds: "", maxPrice: "", keywords: "", status: "active",
};

function CampaignEditor({ initial, isNew, onSave, onDelete, onClose }) {
  const [form, setForm] = useState(() => ({ ...BLANK, ...initial }));
  const [showPreview, setShowPreview] = useState(false);
  const nameRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    if (nameRef.current) nameRef.current.focus();
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, []);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleType = (t) =>
    setForm((f) => ({
      ...f,
      types: f.types.includes(t) ? f.types.filter((x) => x !== t) : [...f.types, t],
    }));
  const toggleArr = (field, v) =>
    setForm((f) => {
      const cur = f[field] || [];
      return { ...f, [field]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] };
    });
  const has = (field, v) => (form[field] || []).includes(v);

  const valid = form.name.trim() && form.location.trim();

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={isNew ? "New search" : "Edit search"}
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <div>
            <span className="eyebrow">{isNew ? "New search" : "Edit search"}</span>
            <h2 className="modal__title">{isNew ? "What are you looking for?" : form.name || "Edit search"}</h2>
          </div>
          <button className="modal__close" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>

        <div className="modal__body">
          <label className="hs-field">
            <span>Search name</span>
            <input ref={nameRef} className="hs-input" placeholder="e.g. Snowdonia — detached with a view"
              value={form.name} onChange={(e) => set("name", e.target.value)} />
          </label>

          <label className="hs-field">
            <span>Where</span>
            <div className="hs-search">
              <Icon name="search" size={16} />
              <input className="hs-input" placeholder="Hampstead, NW3 · or Snowdonia, Gwynedd"
                value={form.location} onChange={(e) => set("location", e.target.value)} />
            </div>
            <p className="field-hint">A place name, area or outcode. The agent finds the local estate agents to write to.</p>
          </label>

          <div className="hs-field">
            <span>Property type</span>
            <div className="chipselect">
              {PROPERTY_TYPES.map((t) => (
                <button key={t} type="button"
                  className={`chipselect__opt${form.types.includes(t) ? " is-on" : ""}`}
                  onClick={() => toggleType(t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="hs-field">
            <span>Condition</span>
            <div className="chipselect">
              {CONDITIONS.map((c) => (
                <button key={c} type="button"
                  className={`chipselect__opt${has("condition", c) ? " is-on" : ""}`}
                  onClick={() => toggleArr("condition", c)}>
                  {c}
                </button>
              ))}
            </div>
            <p className="field-hint">How much of a project you&rsquo;ll take on — agents describe condition in their emails.</p>
          </div>

          <div className="hs-field">
            <span>Land &amp; development</span>
            <div className="chipselect">
              {LAND_OPTIONS.map((o) => (
                <button key={o} type="button"
                  className={`chipselect__opt${has("land", o) ? " is-on" : ""}`}
                  onClick={() => toggleArr("land", o)}>
                  {o}
                </button>
              ))}
            </div>
            <p className="field-hint">Leave off to skip bare land. Pick what makes a plot worth sending — a building to convert, or room to build with planning.</p>
          </div>

          <div className="hs-field">
            <span>Sale method</span>
            <div className="chipselect">
              {SALE_METHODS.map((m) => (
                <button key={m} type="button"
                  className={`chipselect__opt${has("saleMethods", m) ? " is-on" : ""}`}
                  onClick={() => toggleArr("saleMethods", m)}>
                  {m}
                </button>
              ))}
            </div>
            <p className="field-hint">Auction lots suit dilapidated and restoration buys — include them to hear about lots early.</p>
          </div>

          <div className="field-row">
            <label className="hs-field">
              <span>Min bedrooms</span>
              <input className="hs-input" type="number" min="0" placeholder="Any"
                value={form.minBeds} onChange={(e) => set("minBeds", e.target.value)} />
            </label>
            <label className="hs-field">
              <span>Max price (£)</span>
              <input className="hs-input" type="number" min="0" step="5000" placeholder="No limit"
                value={form.maxPrice} onChange={(e) => set("maxPrice", e.target.value)} />
            </label>
          </div>

          <label className="hs-field">
            <span>What you're looking for</span>
            <textarea className="hs-textarea" rows="4"
              placeholder="Describe your taste in plain words — features, mood, must-haves and deal-breakers."
              value={form.keywords} onChange={(e) => set("keywords", e.target.value)} />
            <p className="field-hint">
              <Icon name="sparkles" size={13} /> This shapes the emails sent to agents and how their replies are scored against your taste.
            </p>
          </label>

          <div className="preview">
            <button type="button" className="preview__toggle" onClick={() => setShowPreview((s) => !s)}>
              <Icon name={showPreview ? "chevron-down" : "mail"} size={15} />
              {showPreview ? "Hide outreach preview" : "Preview the email agents will receive"}
            </button>
            {showPreview && (
              <pre className="preview__body">{draftEmail(form)}</pre>
            )}
          </div>
        </div>

        <div className="modal__foot">
          {!isNew ? (
            <button className="hs-btn hs-btn--ghost danger-text" onClick={() => onDelete(form)}>
              <Icon name="trash-2" size={16} /> Delete
            </button>
          ) : <span />}
          <div className="modal__foot-right">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!valid} onClick={() => onSave(form)}>
              {isNew ? "Create search" : "Save changes"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Launch loop modal ---------------------------------------------------
   Operator-driven, send-safe end to end: find agents in the patch → review the
   woven email + each agent's ComplianceGuard verdict → approve the eligible
   ones. Approved agents persist into the Agents table (status "queued"). No
   email is ever sent autonomously — a send fires only after you approve AND
   the guard passes. */
function LaunchAgentRow({ agent, checked, onToggle }) {
  return (
    <li className={`launch-agent${agent.eligible ? "" : " is-blocked"}`} data-eligible={agent.eligible}>
      <label className="launch-agent__label">
        <input type="checkbox" className="launch-agent__check"
          checked={checked} disabled={!agent.eligible} onChange={onToggle} />
        <span className="launch-agent__body">
          <span className="launch-agent__name">{agent.agencyName || agent.email}</span>
          <span className="launch-agent__email">{agent.email}</span>
        </span>
        {agent.eligible ? (
          <span className="launch-agent__ok"><Icon name="check" size={13} /> Eligible</span>
        ) : (
          <span className="launch-agent__reason" title={agent.code}>
            {window.REASON_LABEL[agent.code] || "Blocked"}
          </span>
        )}
      </label>
    </li>
  );
}

function LaunchModal({ search, sending, onClose, onApprove, onViewAgents }) {
  const [phase, setPhase] = useState("finding"); // finding | review | sent
  const [checked, setChecked] = useState(() => new Set());
  const [sentCount, setSentCount] = useState(0);
  const [showDraft, setShowDraft] = useState(false);

  const candidates = useMemo(() =>
    window.discoverAgents(search).map((a) => {
      const chk = window.complianceCheck(a, { sending });
      return { ...a, eligible: chk.eligible, code: chk.code };
    }), [search, sending]);

  const codes = window.searchOutcodes(search);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    const t = setTimeout(() => {
      setPhase("review");
      setChecked(new Set(candidates.filter((a) => a.eligible).map((a) => a.id)));
    }, 1400);
    return () => { clearTimeout(t); document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, []);

  const eligibleCount = candidates.filter((a) => a.eligible).length;
  const checkedCount = checked.size;

  function toggle(id) {
    setChecked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function approve() {
    const recs = candidates.filter((a) => checked.has(a.id)).map((a) => ({
      id: a.id, agencyName: a.agencyName, email: a.email, outcode: a.outcode,
      area: search.location || search.name, searchId: search.id, searchName: search.name,
      mailboxType: a.mailboxType, optedOut: a.optedOut,
      status: "queued", lastContact: "just now",
    }));
    onApprove(recs);
    setSentCount(recs.length);
    setPhase("sent");
  }

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal modal--launch" role="dialog" aria-modal="true" aria-label={`Launch ${search.name}`}
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <div>
            <span className="eyebrow"><Icon name="rocket" size={13} /> Launch search</span>
            <h2 className="modal__title">{search.name}</h2>
          </div>
          <button className="modal__close" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>

        {phase === "sent" ? (
          <div className="launch-sent">
            <div className="confirm-mark launch-sent__mark"><Icon name="send" size={22} /></div>
            <h3 className="confirm-title">
              {sentCount === 0 ? "No sends queued" : `${sentCount} ${sentCount === 1 ? "agent" : "agents"} queued`}
            </h3>
            <p className="confirm-text">
              {sentCount === 0
                ? "Nothing was approved, so no outreach was queued."
                : "Each send still passes the live ComplianceGuard before it leaves — corporate-only, never opted out, kill-switch off, within the warm-up cap. They’re saved to your Agents."}
            </p>
          </div>
        ) : (
          <div className="modal__body">
            {phase === "finding" && (
              <div className="launch-busy">
                <Icon name="loader" size={18} className="spin" />
                Finding estate agents across {codes.join(", ") || "this patch"}…
              </div>
            )}
            {phase === "review" && (
              <>
                <div className="launch-section">
                  <span className="launch-label">
                    Agents in patch
                    <span className="launch-count">{eligibleCount} eligible · {candidates.length} found</span>
                  </span>
                  {candidates.length === 0 ? (
                    <p className="launch-empty">No estate agents found in this patch yet.</p>
                  ) : (
                    <ul className="launch-agents">
                      {candidates.map((a) => (
                        <LaunchAgentRow key={a.id} agent={a} checked={checked.has(a.id)} onToggle={() => toggle(a.id)} />
                      ))}
                    </ul>
                  )}
                </div>
                <div className="preview">
                  <button type="button" className="preview__toggle" onClick={() => setShowDraft((s) => !s)}>
                    <Icon name={showDraft ? "chevron-down" : "mail"} size={15} />
                    {showDraft ? "Hide the email each agent receives" : "Preview the email each agent receives"}
                  </button>
                  {showDraft && <pre className="preview__body">{draftEmail(search)}</pre>}
                </div>
              </>
            )}
          </div>
        )}

        {phase === "sent" ? (
          <div className="modal__foot modal__foot--end">
            <Button variant="secondary" onClick={onClose}>Done</Button>
            <Button variant="primary" icon="arrow-right" onClick={onViewAgents}>View agents</Button>
          </div>
        ) : (
          <div className="modal__foot modal__foot--end">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon="send" disabled={phase !== "review" || checkedCount === 0} onClick={approve}>
              {`Approve & send ${checkedCount}`}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- Screen -------------------------------------------------------------- */
function CampaignsScreen({ agents, sending, onAddAgents, onViewAgents, onViewHomes, onRemoveSearch, removedListings, pendingNew, onConsumedNew }) {
  const [campaigns, setCampaigns] = useState(() => {
    let base = CAMPAIGNS;
    try {
      const saved = localStorage.getItem("hs-campaigns");
      if (saved) base = JSON.parse(saved);
    } catch (e) {}
    // Migrate older saved searchs that predate target outcodes.
    return base.map((c) => {
      if (c.outcodes && c.outcodes.length) return c;
      const seed = CAMPAIGNS.find((s) => s.id === c.id);
      if (seed && seed.outcodes) return { ...c, outcodes: seed.outcodes };
      const parsed = ((c.location || "").match(/\b[A-Z]{1,2}\d{1,2}[A-Z]?\b/gi) || [])
        .map((o) => o.toUpperCase());
      return { ...c, outcodes: parsed };
    });
  });
  const [editing, setEditing] = useState(null); // {campaign} | {isNew:true}
  const [pausing, setPausing] = useState(null);  // search awaiting pause confirmation
  const [removingSearch, setRemovingSearch] = useState(null); // search awaiting delete confirmation
  const [launching, setLaunching] = useState(null); // search being launched

  useEffect(() => {
    try { localStorage.setItem("hs-campaigns", JSON.stringify(campaigns)); } catch (e) {}
  }, [campaigns]);

  // Open the editor when the top-bar "New search" CTA fires.
  useEffect(() => {
    if (pendingNew) { setEditing({ isNew: true }); if (onConsumedNew) onConsumedNew(); }
  }, [pendingNew]);

  const activeCount = campaigns.filter((c) => c.status === "active").length;

  function toggleStatus(id) {
    setCampaigns((cs) => cs.map((c) =>
      c.id === id ? { ...c, status: c.status === "active" ? "paused" : "active" } : c));
  }

  // Resuming is instant; pausing asks first, so there's no doubt about agent contact.
  function requestToggle(id) {
    const c = campaigns.find((x) => x.id === id);
    if (!c) return;
    if (c.status === "active") setPausing(c);
    else toggleStatus(id);
  }

  function save(form) {
    const parsedOutcodes = (form.location.match(/\b[A-Z]{1,2}\d{1,2}[A-Z]?\b/gi) || [])
      .map((o) => o.toUpperCase());
    const clean = {
      ...form,
      outcodes: form.outcodes && form.outcodes.length ? form.outcodes : parsedOutcodes,
      minBeds: form.minBeds === "" ? "" : Number(form.minBeds),
      maxPrice: form.maxPrice === "" ? "" : Number(form.maxPrice),
    };
    setCampaigns((cs) => {
      const exists = cs.some((c) => c.id === clean.id);
      if (exists) return cs.map((c) => (c.id === clean.id ? { ...c, ...clean } : c));
      return [
        { ...clean, id: `cmp-${Date.now()}`, agents: 0, homes: 0,
          lastActivity: "just now", created: "Jun 2026" },
        ...cs,
      ];
    });
    setEditing(null);
  }

  // Deleting a search is a cascade (its agents + homes go too), so ask first.
  function askRemove(form) {
    const c = campaigns.find((x) => x.id === form.id) || form;
    setEditing(null);
    setRemovingSearch(c);
  }

  function confirmRemove() {
    const c = removingSearch;
    if (onRemoveSearch) onRemoveSearch(c);          // cascade: agents + homes
    setCampaigns((cs) => cs.filter((x) => x.id !== c.id));
    setRemovingSearch(null);
  }

  return (
    <div>
      <div className="controls">
        <span className="ctrl-left">
          <span className="count">
            <b>{campaigns.length}</b> searches · <b className="green">{activeCount}</b> active
          </span>
          <InfoTip label="About searches">
            <b>Your searches.</b> Each works a patch — where to look, what kind of home, and the taste that shapes outreach. Launch one to find and contact local agents.
          </InfoTip>
        </span>
      </div>

      {campaigns.length === 0 ? (
        <div className="empty">
          <div className="empty-mark"><Icon name="search" size={26} /></div>
          <p>No searches yet. Create one to start looking.</p>
          <Button variant="secondary" icon="search" onClick={() => setEditing({ isNew: true })}>New search</Button>
        </div>
      ) : (
        <div className="campaign-list">
          {campaigns.map((c) => (
            <CampaignCard key={c.id} c={c} agents={agents}
              onOpen={(camp) => setEditing({ campaign: camp })}
              onToggle={requestToggle}
              onViewHomes={onViewHomes}
              onLaunch={setLaunching}
              onViewAgents={onViewAgents} />
          ))}
        </div>
      )}

      {editing && (
        <CampaignEditor
          initial={editing.campaign || {}}
          isNew={!!editing.isNew}
          onSave={save}
          onDelete={askRemove}
          onClose={() => setEditing(null)}
        />
      )}

      {pausing && (
        <ConfirmPause
          search={pausing}
          onCancel={() => setPausing(null)}
          onConfirm={() => { toggleStatus(pausing.id); setPausing(null); }}
        />
      )}

      {removingSearch && (
        <ConfirmRemoveSearch
          search={removingSearch}
          agents={agents}
          onCancel={() => setRemovingSearch(null)}
          onConfirm={confirmRemove}
        />
      )}

      {launching && (
        <LaunchModal
          search={launching}
          sending={sending}
          onApprove={onAddAgents}
          onViewAgents={() => { const s = launching; setLaunching(null); onViewAgents(s); }}
          onClose={() => setLaunching(null)}
        />
      )}
    </div>
  );
}

/* ---- Pause confirmation -------------------------------------------------- */
function ConfirmPause({ search, onCancel, onConfirm }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, []);
  return (
    <div className="modal-scrim" onMouseDown={onCancel}>
      <div className="modal modal--confirm" role="dialog" aria-modal="true" aria-label="Pause search"
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="confirm-body">
          <div className="confirm-mark"><Icon name="pause" size={22} /></div>
          <h2 className="confirm-title">Pause this search?</h2>
          <p className="confirm-text">
            HomeRanger will stop reaching out to new agents and stop pulling in new listings for
            {" "}<b>{search.name}</b>. No message is sent to anyone — your existing conversations stay
            open and warm, and you can resume any time.
          </p>
        </div>
        <div className="modal__foot modal__foot--end">
          <Button variant="secondary" onClick={onCancel}>Keep active</Button>
          <Button variant="primary" icon="pause" onClick={onConfirm}>Pause search</Button>
        </div>
      </div>
    </div>
  );
}

/* ---- Remove-search confirmation (the cascade) -----------------------------
   Deleting a search removes the search itself, the agents it found, and the
   homes it brought in. Stated plainly with live counts so there's no surprise. */
function ConfirmRemoveSearch({ search, agents, onCancel, onConfirm }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, []);
  const codes = window.searchOutcodes(search).map((o) => o.toUpperCase());
  const agentCount = agents.filter((a) =>
    a.searchId === search.id || codes.includes((a.outcode || "").toUpperCase())).length;
  const homeCount = window.matchSearch(search).length;
  const nothing = !agentCount && !homeCount;
  return (
    <div className="modal-scrim" onMouseDown={onCancel}>
      <div className="modal modal--confirm" role="dialog" aria-modal="true" aria-label="Remove search"
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="confirm-body">
          <div className="confirm-mark confirm-mark--danger"><Icon name="trash-2" size={22} /></div>
          <h2 className="confirm-title">Remove this search?</h2>
          <p className="confirm-text">
            {nothing ? (
              <>Removing <b>{search.name}</b> deletes this search. It hasn&rsquo;t brought in any
              agents or homes yet, so nothing else is affected.</>
            ) : (
              <>
                Removing <b>{search.name}</b> also drops the{" "}
                {agentCount > 0 && <><b>{agentCount} {agentCount === 1 ? "agent" : "agents"}</b> it found</>}
                {agentCount > 0 && homeCount > 0 && " and hides the "}
                {agentCount === 0 && homeCount > 0 && "hides the "}
                {homeCount > 0 && <><b>{homeCount} {homeCount === 1 ? "home" : "homes"}</b> it brought in</>}.{" "}
                {homeCount > 0 && <>The homes aren&rsquo;t deleted &mdash; you can restore them from <b>Dismissed</b>. </>}
                {agentCount > 0 && <>The agents won&rsquo;t be contacted again unless another search finds them.</>}
              </>
            )}
          </p>
        </div>
        <div className="modal__foot modal__foot--end">
          <Button variant="secondary" onClick={onCancel}>Keep search</Button>
          <Button variant="danger" icon="trash-2" onClick={onConfirm}>Remove search</Button>
        </div>
      </div>
    </div>
  );
}

window.CampaignsScreen = CampaignsScreen;
