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

function ListingsTable({ rows, sort, onSort, interested, onToggleInterest }) {
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
            <th className="col-agent">Agent</th>
            <SortHeader id="ageHours" label="Seen" num extraClass="col-seen" sort={sort} onSort={onSort} />
            <th className="col-src" aria-label="Source"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr
              key={l.id}
              className={`row${l.listingUrl ? " clickable" : ""}${interested.includes(l.id) ? " is-interested" : ""}`}
              onClick={() => openSource(l.listingUrl)}
              title={l.note}
            >
              <td className="col-int">
                <InterestButton on={interested.includes(l.id)} onToggle={() => onToggleInterest(l.id)} size={17} />
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
              <td className="agent-cell col-agent">{l.agency}</td>
              <td className="num col-seen"><span className="seen-cell">{l.lastSeen}</span></td>
              <td className="col-src">
                {l.listingUrl ? (
                  <a className="src-icon" href={l.listingUrl} target="_blank" rel="noreferrer"
                    onClick={(e) => e.stopPropagation()} title="View on the agent's site" aria-label="View source">
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
function ListingCard({ l, interested, onToggleInterest }) {
  const clickable = !!l.listingUrl;
  return (
    <div
      className={`hs-card pcard${clickable ? " hs-card--interactive" : ""}${interested ? " is-interested" : ""}`}
      onClick={() => openSource(l.listingUrl)}
      title={l.note}
    >
      <div className="pcard-photo">
        <Photo count={l.photoCount || null} />
        <InterestButton on={interested} onToggle={onToggleInterest} className="intbtn--overlay" size={18} />
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
    `move quickly for the right place. If anything similar is coming up that hasn't reached the ` +
    `portals yet, I'd be glad to hear about it first.\n\n` +
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
    listings.forEach((l) => { (m[l.agency] = m[l.agency] || []).push(l); });
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
function ListingsScreen({ view, scoutFilter, onClearFilter }) {
  const [sort, setSort] = useState({ key: "score", dir: "desc" });
  const [interested, setInterested] = useState(() => {
    try { return JSON.parse(localStorage.getItem("hs-interested")) || []; } catch (e) { return []; }
  });
  const [followUp, setFollowUp] = useState(false);

  useEffect(() => {
    try { localStorage.setItem("hs-interested", JSON.stringify(interested)); } catch (e) {}
  }, [interested]);

  function toggleInterest(id) {
    setInterested((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  }

  function onSort(key) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: SORTS[key].dir },
    );
  }

  const rows = useMemo(() => {
    let base = LISTINGS;
    if (scoutFilter && scoutFilter.outcodes) {
      const set = scoutFilter.outcodes.map((o) => o.toUpperCase());
      base = base.filter((l) => set.includes((l.outcode || "").toUpperCase()));
    }
    return [...base].sort((a, b) => compare(a, b, sort.key, sort.dir));
  }, [sort, scoutFilter]);

  const interestedListings = LISTINGS.filter((l) => interested.includes(l.id));

  return (
    <div>
      {scoutFilter && (
        <div className="scout-filter">
          <div className="sf-left">
            <span className="sf-eyebrow"><Icon name="search" size={13} /> Search</span>
            <div className="sf-name">{scoutFilter.name}</div>
            {scoutFilter.outcodes && scoutFilter.outcodes.length > 0 && (
              <div className="sf-outcodes">
                {scoutFilter.outcodes.map((o) => <span key={o} className="sf-oc">{o}</span>)}
              </div>
            )}
            {scoutFilter.status && (
              <span className={`sf-status sf-status--${scoutFilter.status}`}
                title={scoutFilter.status === "paused"
                  ? "Paused — no new homes are being added; these are the homes it already found"
                  : "Active — still searching this area"}>
                <Icon name={scoutFilter.status === "active" ? "play" : "pause"} size={12} />
                {scoutFilter.status === "active" ? "Active" : "Paused"}
              </span>
            )}
          </div>
          <button className="hs-btn hs-btn--secondary hs-btn--sm" onClick={onClearFilter}>
            <Icon name="x" size={15} /> All listings
          </button>
        </div>
      )}

      <div className="controls">
        <span className="ctrl-left">
          <span className="count">
            <b>{rows.length}</b> {rows.length === 1 ? "home" : "homes"} from your agents
          </span>
          <InfoTip label="About listings" size={14}>
            <b>Homes your agents have sent in.</b> Read from their emails, scored against your taste, and linked back to the source.
          </InfoTip>
        </span>
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
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <Photo style={{ aspectRatio: "1" }} />
          <p>{scoutFilter
            ? `No homes for this search yet — still searching ${scoutFilter.location || "the area"}.`
            : "No listings match your filters."}</p>
        </div>
      ) : view.value === "table" ? (
        <ListingsTable rows={rows} sort={sort} onSort={onSort}
          interested={interested} onToggleInterest={toggleInterest} />
      ) : (
        <div className="grid-cards">
          {rows.map((l) => (
            <ListingCard key={l.id} l={l}
              interested={interested.includes(l.id)}
              onToggleInterest={() => toggleInterest(l.id)} />
          ))}
        </div>
      )}

      <div className="foot-note">
        <Icon name="shield-check" size={14} />
        Click a home to open the agent&rsquo;s page · bookmark homes you like to follow up with their agents
      </div>

      {interestedListings.length > 0 && (
        <InterestBar
          count={interestedListings.length}
          onReview={() => setFollowUp(true)}
          onClear={() => setInterested([])}
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
