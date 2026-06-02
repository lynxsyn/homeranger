/* global React, Icon, Logo, Button, Chip, StatusBadge, EpcBadge, ScoreRing, scoreLabel, Photo, LISTINGS */
const { useState, useMemo } = React;

function gbp(n) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency", currency: "GBP", maximumFractionDigits: 0,
  }).format(n);
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

function ListingsTable({ rows, sort, onSort }) {
  return (
    <div className="tablewrap">
      <table className="listings">
        <thead>
          <tr>
            <SortHeader id="address" label="Home" sort={sort} onSort={onSort} />
            <SortHeader id="price" label="Price" num sort={sort} onSort={onSort} />
            <th className="col-bedbath">Beds</th>
            <SortHeader id="score" label="Match" num sort={sort} onSort={onSort} />
            <th>Status</th>
            <th className="col-agent">Agent</th>
            <SortHeader id="ageHours" label="Seen" num extraClass="col-seen" sort={sort} onSort={onSort} />
            <th className="col-src" aria-label="Source"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr
              key={l.id}
              className={`row${l.listingUrl ? " clickable" : ""}`}
              onClick={() => openSource(l.listingUrl)}
              title={l.note}
            >
              <td>
                <div className="cell-addr">
                  <Photo className="thumb" />
                  <span className="at">
                    <b>{l.address}</b>
                    <small>{l.postcode} · {l.propertyType}</small>
                  </span>
                </div>
              </td>
              <td className="num price-cell">{gbp(l.price)}</td>
              <td className="col-bedbath">
                <span className="bedbath">
                  <span><Icon name="bed-double" size={15} />{l.bedrooms}</span>
                  <span><Icon name="bath" size={15} />{l.bathrooms}</span>
                </span>
              </td>
              <td className="num">
                <div style={{ display: "inline-flex", justifyContent: "flex-end", width: "100%" }}>
                  <ScoreRing value={l.score} size={36} />
                </div>
              </td>
              <td><StatusBadge status={l.status} /></td>
              <td className="agent-cell col-agent">{l.agency}</td>
              <td className="num col-seen"><span className="seen-cell">{l.lastSeen}</span></td>
              <td className="col-src">
                {l.listingUrl ? (
                  <a className="src-icon" href={l.listingUrl} target="_blank" rel="noreferrer"
                    onClick={(e) => e.stopPropagation()} title="View on the agent's site" aria-label="View source">
                    <Icon name="external-link" size={16} />
                  </a>
                ) : (
                  <span className="src-icon src-icon--mail" title="Email only — not yet listed" aria-label="Email only">
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
function ListingCard({ l }) {
  const clickable = !!l.listingUrl;
  return (
    <div
      className={`hs-card pcard${clickable ? " hs-card--interactive" : ""}`}
      onClick={() => openSource(l.listingUrl)}
      title={l.note}
    >
      <Photo count={l.photoCount || null} />
      <div className="body">
        <div className="head">
          <div style={{ minWidth: 0 }}>
            <div className="price">{gbp(l.price)}</div>
            <div className="addr">{l.address}</div>
            <div className="sub">{l.postcode} · {l.propertyType}</div>
          </div>
          <StatusBadge status={l.status} />
        </div>
        <div className="chips">
          <Chip icon="bed-double">{l.bedrooms}</Chip>
          <Chip icon="bath">{l.bathrooms}</Chip>
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

/* ---- Screen -------------------------------------------------------------- */
function ListingsScreen({ view }) {
  const [sort, setSort] = useState({ key: "score", dir: "desc" });

  function onSort(key) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: SORTS[key].dir },
    );
  }

  const rows = useMemo(
    () => [...LISTINGS].sort((a, b) => compare(a, b, sort.key, sort.dir)),
    [sort],
  );

  const preMarket = rows.filter((l) => l.status === "pre_market").length;

  return (
    <div>
      <div className="page-head">
        <h1 className="t-h1">Listings</h1>
        <p>Homes your agents have sent in — read from their emails, scored against your taste, and linked back to the source. Found before it&rsquo;s listed.</p>
      </div>

      <div className="controls">
        <span className="count">
          <b>{rows.length}</b> homes · <b className="gold">{preMarket}</b> pre-market
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
          <p>No listings match your filters.</p>
        </div>
      ) : view.value === "table" ? (
        <ListingsTable rows={rows} sort={sort} onSort={onSort} />
      ) : (
        <div className="grid-cards">
          {rows.map((l) => <ListingCard key={l.id} l={l} />)}
        </div>
      )}

      <div className="foot-note">
        <Icon name="shield-check" size={14} />
        Click a home to open the agent&rsquo;s page · pre-market homes are email-only until they list
      </div>
    </div>
  );
}

window.ListingsScreen = ListingsScreen;
