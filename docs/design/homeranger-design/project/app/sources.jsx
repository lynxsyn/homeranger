/* global React, Icon, Button, InfoTip, coverageSummary, listingsForSource */
/* HomeRanger — Sources. The *other* path listings arrive by.

   The estate-agent path is outbound and relationship-driven: a Search is
   launched, local agents are found and emailed, and their replies become
   listings. This path is the opposite shape — inbound and scheduled. A curated
   set of UK auction houses and land/farm portals is crawled on a cadence; lots
   and plots are parsed and scored against your taste, often before they reach
   Rightmove / Zoopla. There is no one to email and nothing to approve, so the
   furniture is different: no warm-up, no kill-switch, no threads. A source
   carries a coverage filter, a price cap, a crawl health dot, and — for auction
   houses — a sale date, the one hard deadline the agent path never has.

   Linking, both ways:
   - the source's domain links straight out to the auction house / portal;
   - "View lots" drills into the Listings table filtered to that source, where
     each lot links on to its own particulars / auction-lot page.

   Sources are curated by hand (no in-app connect flow); here you watch them
   work, and everything in the list is being monitored. */

const { useState: useSrcState, useMemo: useSrcMemo } = React;

/* The project's "today" — sale countdowns are measured from here so the demo
   reads the same whenever it's opened. */
const SRC_TODAY = new Date("2026-06-05T09:00:00");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysUntil(iso) {
  const d = new Date(iso + "T00:00:00");
  return Math.round((d - SRC_TODAY) / DAY_MS);
}
function saleCountdown(days) {
  if (days <= 0) return "Sale today";
  if (days === 1) return "Sale tomorrow";
  return `Sale in ${days} days`;
}
function saleDateLabel(iso) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short",
  }).format(new Date(iso + "T00:00:00"));
}
function capLabel(n) {
  return n >= 1000 ? `\u00a3${Math.round(n / 1000)}k` : `\u00a3${n}`;
}

/* ---- The curated source set ----------------------------------------------
   UK auction houses and land/farm portals, filtered to the rural patches the
   land + restoration searches work (mid-Wales Powys, Snowdonia/Gwynedd). Each
   carries the only two things tunable per source: a coverage filter (outcodes)
   and a price cap. The count of lots it has found is derived from the listings
   it has actually hydrated, so it always matches what "View lots" shows. */
const SOURCES = [
  {
    id: "src-allsop", name: "Allsop \u2014 Residential Auctions", kind: "auction",
    domain: "allsop.co.uk", outcodes: ["SY18", "SY16", "LD1", "LD2", "LL40"],
    maxPrice: 650000, lastRun: "9m ago", health: "ok", saleDate: "2026-06-09",
  },
  {
    id: "src-bondwolfe", name: "Bond Wolfe Auctions", kind: "auction",
    domain: "bondwolfe.com", outcodes: ["LD1", "LD3", "SY18"],
    maxPrice: 450000, lastRun: "26m ago", health: "warn", saleDate: "2026-06-11",
  },
  {
    id: "src-paulfosh", name: "Paul Fosh Auctions", kind: "auction",
    domain: "paulfoshauctions.com", outcodes: ["SY18", "LD1", "LD3"],
    maxPrice: 400000, lastRun: "1h ago", health: "ok", saleDate: "2026-06-17",
  },
  {
    id: "src-sdl", name: "SDL Property Auctions", kind: "auction",
    domain: "sdlauctions.co.uk", outcodes: ["SY16", "SY18", "LD1"],
    maxPrice: 500000, lastRun: "3h ago", health: "ok", saleDate: "2026-06-26",
  },
  {
    id: "src-uklandandfarms", name: "UK Land & Farms", kind: "land",
    domain: "uklandandfarms.co.uk", outcodes: ["LL40", "LL48", "SY18", "SY20", "LD1"],
    maxPrice: 400000, lastRun: "4m ago", health: "ok",
  },
  {
    id: "src-savillsrural", name: "Savills Rural & Farms", kind: "land",
    domain: "savills.co.uk/rural", outcodes: ["SY18", "LD1", "LL40", "LL42"],
    maxPrice: 750000, lastRun: "2h ago", health: "ok",
  },
  {
    id: "src-hhland", name: "H&H Land & Estates", kind: "land",
    domain: "hhland.co.uk", outcodes: ["LL55", "LL57", "LL48"],
    maxPrice: 500000, lastRun: "1d ago", health: "ok",
  },
  {
    id: "src-struttparker", name: "Strutt & Parker \u2014 Farms & Estates", kind: "land",
    domain: "struttandparker.com", outcodes: ["LD1", "LD2", "LD3", "SY18"],
    maxPrice: null, lastRun: "5h ago", health: "ok",
  },
];

const SOURCE_FILTERS = [
  { id: "all", label: "All" },
  { id: "auction", label: "Auction houses" },
  { id: "land", label: "Land & farm" },
];

function foundFor(id) {
  return (window.listingsForSource ? window.listingsForSource(id) : []).length;
}

/* ---- Type mark (tinted rounded square — gold gavel / green trees) --------- */
function SourceMark({ kind }) {
  return (
    <span className={`source-mark source-mark--${kind}`} aria-hidden="true">
      <Icon name={kind === "auction" ? "gavel" : "trees"} size={19} />
    </span>
  );
}

/* ---- Coverage + price cap (the two tunables, stacked) --------------------- */
function SourceCoverage({ source }) {
  const s = useSrcMemo(() => coverageSummary(source.outcodes), [source.outcodes]);
  const oneline = s.count <= 1
    ? <><span className="src-cov__area">{s.primaryTown}</span>{s.primary && <span className="sf-oc">{s.primary}</span>}</>
    : <><span className="src-cov__area">{s.region}</span><span className="src-cov__count">{s.count} outcodes</span></>;
  return (
    <div className="src-cov">
      <span className="src-cov__main"><Icon name="map-pin" size={13} />{oneline}</span>
      <span className="src-cov__price">{source.maxPrice == null
        ? <span className="src-cov__nocap">No price cap</span>
        : <>up to <b>{capLabel(source.maxPrice)}</b></>}</span>
    </div>
  );
}

/* ---- The signal that makes this path different: a hard sale date ---------- */
function SaleCell({ source }) {
  if (source.kind !== "auction") {
    return (
      <span className="cadence">
        <Icon name="refresh-cw" size={14} /> Rolling listings
      </span>
    );
  }
  const days = daysUntil(source.saleDate);
  const soon = days <= 7;
  return (
    <span className="sale-cell">
      <span className={`sale-badge${soon ? " sale-badge--soon" : ""}`}>
        <Icon name="calendar-clock" size={13} /> {saleCountdown(days)}
      </span>
      <span className="sale-date">{saleDateLabel(source.saleDate)}</span>
    </span>
  );
}

/* ---- Screen --------------------------------------------------------------- */
function SourcesScreen({ onViewLots }) {
  const [kindFilter, setKindFilter] = useSrcState("all");

  // Default sort carries the urgency: auctions by soonest sale, then land/farm
  // portals by most lots found.
  const rows = useSrcMemo(() => {
    let base = SOURCES;
    if (kindFilter !== "all") base = base.filter((s) => s.kind === kindFilter);
    return [...base].sort((a, b) => {
      const ak = a.kind === "auction" ? 0 : 1;
      const bk = b.kind === "auction" ? 0 : 1;
      if (ak !== bk) return ak - bk;
      if (a.kind === "auction") return daysUntil(a.saleDate) - daysUntil(b.saleDate);
      return foundFor(b.id) - foundFor(a.id);
    });
  }, [kindFilter]);

  const metrics = useSrcMemo(() => {
    const found = SOURCES.reduce((n, s) => n + foundFor(s.id), 0);
    const nextDays = SOURCES
      .filter((s) => s.kind === "auction")
      .map((s) => daysUntil(s.saleDate))
      .filter((d) => d >= 0)
      .sort((a, b) => a - b)[0];
    return { count: SOURCES.length, found, nextDays };
  }, []);

  const nextSale = metrics.nextDays == null ? "\u2014"
    : metrics.nextDays === 0 ? "Today"
    : metrics.nextDays === 1 ? "Tomorrow"
    : `In ${metrics.nextDays} days`;

  return (
    <div>
      <div className="ag-metrics">
        <div className="ag-metric">
          <span className="agm-ic"><Icon name="rss" size={16} /></span>
          <span className="agm-val">{metrics.count}</span>
          <span className="agm-label">Monitored sources</span>
        </div>
        <div className="ag-metric">
          <span className="agm-ic"><Icon name="home" size={16} /></span>
          <span className="agm-val">{metrics.found}</span>
          <span className="agm-label">Lots ingested</span>
        </div>
        <div className="ag-metric">
          <span className="agm-ic agm-ic--gold"><Icon name="gavel" size={16} /></span>
          <span className="agm-val agm-val--gold">{nextSale}</span>
          <span className="agm-label">Next auction</span>
        </div>
      </div>

      <div className="controls">
        <div className="statusfilter" role="group" aria-label="Filter by source type">
          {SOURCE_FILTERS.map((f) => (
            <button key={f.id} className={`sf-chip${kindFilter === f.id ? " is-on" : ""}`}
              aria-pressed={kindFilter === f.id} onClick={() => setKindFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <span className="ctrl-left">
          <span className="count">
            <b>{rows.length}</b> {rows.length === 1 ? "source" : "sources"}
          </span>
          <InfoTip label="About sources" align="right" size={14}>
            <b>The other way listings arrive.</b> A hand-picked set of UK auction houses and
            land &amp; farm portals, crawled on a schedule. Lots and plots are parsed and scored
            against your taste &mdash; often before they reach the big portals. Open a source to
            visit the site, or view the lots it has brought into your listings.
          </InfoTip>
        </span>
      </div>

      <div className="tablewrap">
        <table className="listings sources-table">
          <thead>
            <tr>
              <th>Source</th>
              <th className="col-cov-src">Coverage &amp; cap</th>
              <th>Next sale</th>
              <th className="num col-lots">Lots found</th>
              <th className="num col-run">Last crawl</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const found = foundFor(s.id);
              return (
                <tr key={s.id} className="row">
                  <td>
                    <div className="cell-source">
                      <SourceMark kind={s.kind} />
                      <span className="at">
                        <b>{s.name}</b>
                        <small>
                          <span className="src-kind">{s.kind === "auction" ? "Auction house" : "Land & farm portal"}</span>
                          {" \u00b7 "}
                          <a className="src-site" href={`https://${s.domain}`} target="_blank" rel="noreferrer"
                            title={`Visit ${s.domain}`}>
                            {s.domain}<Icon name="external-link" size={11} />
                          </a>
                        </small>
                      </span>
                    </div>
                  </td>
                  <td className="col-cov-src"><SourceCoverage source={s} /></td>
                  <td><SaleCell source={s} /></td>
                  <td className="num col-lots">
                    {found > 0 ? (
                      <button className="lots-link" onClick={() => onViewLots(s)}
                        title={`View the ${found} ${found === 1 ? "lot" : "lots"} from ${s.name}`}>
                        <Icon name="home" size={14} /> {found} {found === 1 ? "lot" : "lots"}
                        <Icon name="arrow-right" size={13} />
                      </button>
                    ) : (
                      <span className="homes-cell na">{"\u2014"}</span>
                    )}
                  </td>
                  <td className="num col-run">
                    <span className="run-cell">
                      <span className={`run-dot run-dot--${s.health}`} aria-hidden="true" />
                      <span className="run-time">{s.lastRun}</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="foot-note">
        <Icon name="route" size={14} />
        Crawled on a schedule and scored against your taste &mdash; the same listings table, found a different way
      </div>
    </div>
  );
}

window.SourcesScreen = SourcesScreen;
