/* global React, Icon, Logo, Button, Chip, StatusBadge, EpcBadge, ScoreRing, scoreLabel, Photo, LISTINGS */
const { useState, useMemo, useEffect } = React;

function gbp(n) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency", currency: "GBP", maximumFractionDigits: 0,
  }).format(n);
}

/* Bookmark toggle — "I'm interested", queues the home for a follow-up. */
function InterestButton({ on, onToggle, size = 18, className = "" }) {
  return (
    <button
      className={`intbtn${on ? " is-on" : ""} ${className}`}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      aria-pressed={on}
      title={on ? "Saved to follow-ups" : "I'm interested — save for follow-up"}
    >
      <Icon name="bookmark" size={size} />
    </button>
  );
}

/* Dismiss / restore — hides a home from the feed (a silent taste signal, never
   sent to the agent). Reversible: restores from the Dismissed view. */
function DismissButton({ dismissed, onToggle, size = 17, className = "" }) {
  return (
    <button
      className={`dismissbtn${dismissed ? " is-restore" : ""} ${className}`}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      title={dismissed ? "Restore to your listings" : "Dismiss — stop showing me this"}
      aria-label={dismissed ? "Restore home" : "Dismiss home"}
    >
      <Icon name={dismissed ? "rotate-ccw" : "eye-off"} size={size} />
    </button>
  );
}

/* Sort definitions — key, human label for the dropdown, type, default direction. */
const SORTS = {
  score:    { label: "Match score", type: "num", dir: "desc" },
  ageHours: { label: "Newest first", type: "num", dir: "asc" },
  price:    { label: "Price",        type: "num", dir: "desc" },
  bedrooms: { label: "Bedrooms",     type: "num", dir: "desc" },
  address:  { label: "Address",      type: "str", dir: "asc" },
};

function compare(a, b, key, dir) {
  if (SORTS[key].type === "str") {
    const r = String(a[key]).localeCompare(String(b[key]));
    return dir === "asc" ? r : -r;
  }
  const av = a[key], bv = b[key];
  const an = av == null, bn = bv == null;
  if (an && bn) return 0;
  if (an) return 1;        // nulls (un-scored, etc.) always sink
  if (bn) return -1;
  return dir === "asc" ? av - bv : bv - av;
}

function openSource(url) {
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}

/* ---- Table view ---------------------------------------------------------- */
function SortHeader({ id, label, num, extraClass = "", sort, onSort }) {
  const active = sort.key === id;
  return (
    <th
      className={`${num ? "num " : ""}${extraClass ? extraClass + " " : ""}sortable${active ? " active" : ""}`}
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

function ListingsTable({ rows, sort, onSort, interested, onToggleInterest, dismissed, onToggleDismiss }) {
  return (
    <div className="tablewrap">
      <table className="listings">
        <thead>
          <tr>
            <th className="col-int" aria-label="Interested"></th>
            <SortHeader id="address" label="Home" sort={sort} onSort={onSort} />
            <SortHeader id="price" label="Price" num sort={sort} onSort={onSort} />
            <th className="col-bedbath">Beds</th>
            <SortHeader id="score" label="Match" num sort={sort} onSort={onSort} />
            <th className="col-agent">From</th>
            <SortHeader id="ageHours" label="Seen" num extraClass="col-seen" sort={sort} onSort={onSort} />
            <th className="col-src" aria-label="Source"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr
              key={l.id}
              className={`row${l.listingUrl ? " clickable" : ""}${interested.includes(l.id) ? " is-interested" : ""}${dismissed && dismissed.includes(l.id) ? " is-dismissed" : ""}`}
              onClick={() => openSource(l.listingUrl)}
              title={l.note}
            >
              <td className="col-int">
                <div className="rowacts">
                  <InterestButton on={interested.includes(l.id)} onToggle={() => onToggleInterest(l.id)} size={17} />
                  <DismissButton
                    dismissed={dismissed && dismissed.includes(l.id)}
                    onToggle={() => onToggleDismiss(l.id)}
                  />
                </div>
              </td>
              <td>
                <div className="cell-addr">
                  <Photo className="thumb" />
                  <span className="at">
                    <b>{l.address}</b>
                    <small>{l.postcode} · {l.propertyType}</small>
                  </span>
                  {l.tag && <span className="listing-tag">{l.tag}</span>}
                </div>
              </td>
              <td className="num price-cell">{gbp(l.price)}</td>
              <td className="col-bedbath">
                {l.bedrooms != null ? (
                  <span className="bedbath">
                    <span><Icon name="bed-double" size={15} />{l.bedrooms}</span>
                    <span><Icon name="bath" size={15} />{l.bathrooms}</span>
                  </span>
                ) : (
                  <span className="bedbath na">—</span>
                )}
              </td>
              <td className="num">
                <div style={{ display: "inline-flex", justifyContent: "flex-end", width: "100%" }}>
                  <ScoreRing value={l.score} size={36} />
                </div>
              </td>
              <td className="agent-cell col-agent">{l.sourceName || l.agency}</td>
              <td className="num col-seen"><span className="seen-cell">{l.lastSeen}</span></td>
              <td className="col-src">
                {l.listingUrl ? (
                  <a className="src-icon" href={l.listingUrl} target="_blank" rel="noreferrer"
                    onClick={(e) => e.stopPropagation()} title={l.sourceId ? "View this lot on the source site" : "View on the agent's site"} aria-label="View source">
                    <Icon name="external-link" size={16} />
                  </a>
                ) : (
                  <span className="src-icon src-icon--mail" title="The agent sent this by email — no link included" aria-label="Email only">
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
function ListingCard({ l, interested, onToggleInterest, dismissed, onToggleDismiss }) {
  const clickable = !!l.listingUrl;
  return (
    <div
      className={`hs-card pcard${clickable ? " hs-card--interactive" : ""}${interested ? " is-interested" : ""}${dismissed ? " is-dismissed" : ""}`}
      onClick={() => openSource(l.listingUrl)}
      title={l.note}
    >
      <div className="pcard-photo">
        <Photo count={l.photoCount || null} />
        <InterestButton on={interested} onToggle={onToggleInterest} className="intbtn--overlay" size={18} />
        <DismissButton dismissed={dismissed} onToggle={onToggleDismiss} className="dismissbtn--overlay" size={16} />
      </div>
      <div className="body">
        <div className="head">
          <div style={{ minWidth: 0 }}>
            <div className="price">{gbp(l.price)}</div>
            <div className="addr">{l.address}</div>
            <div className="sub">{l.postcode} · {l.propertyType}</div>
          </div>
        </div>
        <div className="chips">
          {l.tag && <span className="listing-tag">{l.tag}</span>}
          {l.bedrooms != null && <Chip icon="bed-double">{l.bedrooms}</Chip>}
          {l.bathrooms != null && <Chip icon="bath">{l.bathrooms}</Chip>}
          <Chip icon="map-pin">{l.outcode}</Chip>
          <EpcBadge band={l.epc} />
        </div>
        <div className="foot">
          <div className="hs-score">
            <ScoreRing value={l.score} />
            <div className="hs-score__label">
              <b>{scoreLabel(l.score)}</b>
              <span>{l.score == null ? "awaiting photos" : `${l.score} / 100 · ${l.lastSeen}`}</span>
            </div>
          </div>
          {l.listingUrl ? (
            <a className="src-link" href={l.listingUrl} target="_blank" rel="noreferrer"
              onClick={(e) => e.stopPropagation()}>
              Source <Icon name="external-link" size={14} />
            </a>
          ) : (
            <span className="src-none"><Icon name="mail" size={13} /> Email only</span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- Follow-up flow ------------------------------------------------------ */
function joinNames(arr) {
  if (arr.length === 1) return arr[0];
  return arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];
}

function followUpEmail(listings) {
  const single = listings.length === 1;
  const names = joinNames(listings.map((l) => l.address));
  return (
    `Hello,\n\n` +
    `Thank you for sending ${single ? "this" : "these"} through. I'm very interested in ` +
    `${names}${single ? "" : " — each looks like a strong fit"}.\n\n` +
    `Could we arrange ${single ? "a viewing" : "viewings"}? I'm flexible on timing and ready to ` +
    `move quickly for the right place. If anything similar is coming up, I'd be glad to hear about ` +
    `it early.\n\n` +
    `Many thanks`
  );
}

function FollowUpModal({ listings, onClose, onSent }) {
  const [sent, setSent] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, []);

  // One message per agency, even if you liked several of their homes.
  const groups = useMemo(() => {
    const m = {};
    listings.forEach((l) => { const key = l.agency || l.sourceName; (m[key] = m[key] || []).push(l); });
    return Object.entries(m).map(([agency, ls]) => ({ agency, listings: ls }));
  }, [listings]);

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Follow up with agents"
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <div>
            <span className="eyebrow">Follow up</span>
            <h2 className="modal__title">
              {sent ? "Follow-ups sent" : `Tell ${groups.length} ${groups.length === 1 ? "agent" : "agents"} you're interested`}
            </h2>
          </div>
          <button className="modal__close" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>

        {sent ? (
          <div className="confirm-body">
            <div className="confirm-mark confirm-mark--ok"><Icon name="check" size={24} /></div>
            <h2 className="confirm-title">
              Sent to {groups.length} {groups.length === 1 ? "agent" : "agents"}
            </h2>
            <p className="confirm-text">
              Each agent gets a single, warm note about the {listings.length === 1 ? "home" : "homes"} you
              liked. Their replies come straight back into your inbox — nothing is shared beyond the agents you chose.
            </p>
          </div>
        ) : (
          <div className="modal__body">
            <p className="followup-intro">
              One message per agent, in your voice. Review and send — or close to keep them saved.
            </p>
            {groups.map((g) => (
              <div className="followup-group" key={g.agency}>
                <div className="fg-head">
                  <span className="fg-agency"><Icon name="mail" size={15} /> {g.agency}</span>
                  <span className="fg-count">{g.listings.length} {g.listings.length === 1 ? "home" : "homes"}</span>
                </div>
                <div className="fg-homes">
                  {g.listings.map((l) => (
                    <span className="fg-home" key={l.id}>{l.address} · {gbp(l.price)}</span>
                  ))}
                </div>
                <pre className="preview__body fg-draft">{followUpEmail(g.listings)}</pre>
              </div>
            ))}
          </div>
        )}

        <div className="modal__foot modal__foot--end">
          {sent ? (
            <Button variant="primary" onClick={onSent}>Done</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>Not now</Button>
              <Button variant="primary" icon="mail" onClick={() => setSent(true)}>
                Send {groups.length} {groups.length === 1 ? "follow-up" : "follow-ups"}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function InterestBar({ count, onReview, onClear }) {
  return (
    <div className="interest-bar" role="status">
      <span className="ib-count">
        <Icon name="bookmark" size={16} />
        <b>{count}</b> {count === 1 ? "home" : "homes"} you're interested in
      </span>
      <div className="ib-actions">
        <button className="ib-clear" onClick={onClear}>Clear</button>
        <Button variant="primary" size="sm" icon="mail" onClick={onReview}>Draft follow-ups</Button>
      </div>
    </div>
  );
}

/* ---- Screen -------------------------------------------------------------- */
function ListingsScreen({ view, searchFilter, sourceFilter, onClearFilter, dismissed, setDismissed }) {
  const [sort, setSort] = useState({ key: "score", dir: "desc" });
  const [interested, setInterested] = useState(() => {
    try { return JSON.parse(localStorage.getItem("hs-interested")) || []; } catch (e) { return []; }
  });
  const [bucket, setBucket] = useState("active"); // active | saved | dismissed
  const [undo, setUndo] = useState(null);          // { id } for the dismiss snackbar
  const [followUp, setFollowUp] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);

  // Auto-clear the undo snackbar after a few seconds.
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 6000);
    return () => clearTimeout(t);
  }, [undo]);

  useEffect(() => {
    try { localStorage.setItem("hs-interested", JSON.stringify(interested)); } catch (e) {}
  }, [interested]);

  function toggleInterest(id) {
    setInterested((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  }

  // Dismiss = silent taste signal (never sent to the agent), reversible.
  function dismiss(id) {
    setInterested((s) => s.filter((x) => x !== id));  // a dismissed home isn't “saved”
    setDismissed((s) => s.includes(id) ? s : [...s, id]);
    setUndo({ id });
  }
  function restore(id) {
    setDismissed((s) => s.filter((x) => x !== id));
    setUndo(null);
  }
  function toggleDismiss(id) {
    if (dismissed.includes(id)) restore(id); else dismiss(id);
  }

  function onSort(key) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: SORTS[key].dir },
    );
  }

  // Everything in this patch (search-deleted homes are merely hidden, below).
  const visible = useMemo(() => {
    let base = LISTINGS;
    if (sourceFilter) {
      base = base.filter((l) => l.sourceId === sourceFilter.id);
    } else if (searchFilter && searchFilter.outcodes) {
      const set = searchFilter.outcodes.map((o) => o.toUpperCase());
      base = base.filter((l) => set.includes((l.outcode || "").toUpperCase()));
    }
    return base;
  }, [searchFilter, sourceFilter]);

  const counts = useMemo(() => ({
    active: visible.filter((l) => !dismissed.includes(l.id)).length,
    saved: visible.filter((l) => interested.includes(l.id) && !dismissed.includes(l.id)).length,
    dismissed: visible.filter((l) => dismissed.includes(l.id)).length,
  }), [visible, interested, dismissed]);

  const rows = useMemo(() => {
    let base;
    if (bucket === "saved") base = visible.filter((l) => interested.includes(l.id) && !dismissed.includes(l.id));
    else if (bucket === "dismissed") base = visible.filter((l) => dismissed.includes(l.id));
    else base = visible.filter((l) => !dismissed.includes(l.id));
    return [...base].sort((a, b) => compare(a, b, sort.key, sort.dir));
  }, [visible, bucket, interested, dismissed, sort]);

  const interestedListings = visible.filter((l) => interested.includes(l.id) && !dismissed.includes(l.id));
  const BUCKETS = [
    { id: "active", label: "Active" },
    { id: "saved", label: "Saved" },
    { id: "dismissed", label: "Dismissed" },
  ];

  return (
    <div>
      {sourceFilter && (
        <div className="search-filter source-filter">
          <div className="sf-left">
            <span className="sf-eyebrow">
              <Icon name={sourceFilter.kind === "auction" ? "gavel" : "trees"} size={13} /> Source
            </span>
            <div className="sf-name">{sourceFilter.name}</div>
            <a className="sf-visit" href={`https://${sourceFilter.domain}`} target="_blank" rel="noreferrer">
              {sourceFilter.domain}<Icon name="external-link" size={13} />
            </a>
          </div>
          <button className="hs-btn hs-btn--secondary hs-btn--sm" onClick={onClearFilter}>
            <Icon name="x" size={15} /> All listings
          </button>
        </div>
      )}

      {searchFilter && (
        <div className="search-filter">
          <div className="sf-left">
            <span className="sf-eyebrow"><Icon name="search" size={13} /> Search</span>
            <div className="sf-name">{searchFilter.name}</div>
            {searchFilter.outcodes && searchFilter.outcodes.length > 0 && (
              <div className="sf-outcodes">
                {searchFilter.outcodes.map((o) => <span key={o} className="sf-oc">{o}</span>)}
              </div>
            )}
            {searchFilter.status && (
              <span className={`sf-status sf-status--${searchFilter.status}`}
                title={searchFilter.status === "paused"
                  ? "Paused — no new homes are being added; these are the homes it already found"
                  : "Active — still searching this area"}>
                <Icon name={searchFilter.status === "active" ? "play" : "pause"} size={12} />
                {searchFilter.status === "active" ? "Active" : "Paused"}
              </span>
            )}
          </div>
          <button className="hs-btn hs-btn--secondary hs-btn--sm" onClick={onClearFilter}>
            <Icon name="x" size={15} /> All listings
          </button>
        </div>
      )}

      <div className="controls">
        <div className="statusfilter" role="group" aria-label="Filter listings">
          {BUCKETS.map((b) => (
            <button key={b.id} className={`sf-chip${bucket === b.id ? " is-on" : ""}`}
              aria-pressed={bucket === b.id} onClick={() => setBucket(b.id)}>
              {b.label} <span className="sf-chip__n">{counts[b.id]}</span>
            </button>
          ))}
        </div>
        <div className="controls__right">
          <div className="sortwrap">
            <label htmlFor="sortby">Sort</label>
            <select id="sortby" className="hs-select" value={sort.key}
              onChange={(e) => setSort({ key: e.target.value, dir: SORTS[e.target.value].dir })}>
              {Object.entries(SORTS).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </div>
          <div className="viewtoggle" role="group" aria-label="View">
            <button aria-pressed={view.value === "table"} onClick={() => view.set("table")} aria-label="Table view">
              <Icon name="rows-3" size={17} />
            </button>
            <button aria-pressed={view.value === "cards"} onClick={() => view.set("cards")} aria-label="Card view">
              <Icon name="layout-grid" size={17} />
            </button>
            <button onClick={() => setMapOpen(true)} aria-label="Map view"
              disabled={rows.length === 0} title="See these homes on a map">
              <Icon name="map-pin" size={17} />
            </button>
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <Photo style={{ aspectRatio: "1" }} />
          <p>{bucket === "saved"
            ? "No saved homes yet — bookmark ones you like to gather them here."
            : bucket === "dismissed"
            ? "Nothing dismissed. Homes you hide land here, and you can restore them any time."
            : sourceFilter
            ? `No lots from ${sourceFilter.name} yet \u2014 it\u2019s being crawled; lots appear here as they\u2019re found.`
            : searchFilter
            ? `No homes for this search yet — still searching ${searchFilter.location || "the area"}.`
            : "No listings match your filters."}</p>
        </div>
      ) : view.value === "table" ? (
        <ListingsTable rows={rows} sort={sort} onSort={onSort}
          interested={interested} onToggleInterest={toggleInterest}
          dismissed={dismissed} onToggleDismiss={toggleDismiss} />
      ) : (
        <div className="grid-cards">
          {rows.map((l) => (
            <ListingCard key={l.id} l={l}
              interested={interested.includes(l.id)}
              onToggleInterest={() => toggleInterest(l.id)}
              dismissed={dismissed.includes(l.id)}
              onToggleDismiss={() => toggleDismiss(l.id)} />
          ))}
        </div>
      )}

      <div className="foot-note">
        <Icon name="shield-check" size={14} />
        {bucket === "dismissed"
          ? "Dismissed homes are hidden from your feed and help tune your scoring — nothing is sent to the agent. Restore any time."
          : "Bookmark homes you like to follow up · dismiss ones you don’t to tune your scoring — silently, never to the agent."}
      </div>

      {interestedListings.length > 0 && (
        <InterestBar
          count={interestedListings.length}
          onReview={() => setFollowUp(true)}
          onClear={() => setInterested([])}
        />
      )}

      {undo && (() => {
        const home = LISTINGS.find((l) => l.id === undo.id);
        return (
          <div className="toast" role="status">
            <span className="toast__msg">
              <Icon name="eye-off" size={15} />
              Dismissed{home ? ` ${home.address}` : ""}
            </span>
            <button className="toast__action" onClick={() => restore(undo.id)}>Undo</button>
          </div>
        );
      })()}

      {mapOpen && (
        <MapModal
          rows={rows}
          areaLabel={sourceFilter ? sourceFilter.name : searchFilter ? searchFilter.name : null}
          interested={interested}
          onToggleInterest={toggleInterest}
          onClose={() => setMapOpen(false)}
        />
      )}

      {followUp && (
        <FollowUpModal
          listings={interestedListings}
          onClose={() => setFollowUp(false)}
          onSent={() => { setInterested([]); setFollowUp(false); }}
        />
      )}
    </div>
  );
}

window.ListingsScreen = ListingsScreen;
