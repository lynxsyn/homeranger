/* global React, L, Icon, ScoreRing, scoreLabel */
/* HomeRanger — map view. Plots the (filtered) listings at their approximate
   location and keeps a side list in sync with the markers. Uses Leaflet with a
   calm light/dark CartoDB basemap; markers are brand-green price pins. */
const { useState, useRef, useEffect, useMemo } = React;

/* Compact price for the pins (£625k, £1.2m); full £ in the list. */
function priceShort(n) {
  if (n == null) return "POA";
  if (n >= 1e6) return "£" + (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + "m";
  return "£" + Math.round(n / 1000) + "k";
}
function priceFull(n) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency", currency: "GBP", maximumFractionDigits: 0,
  }).format(n);
}

/* Light + dark CartoDB tiles so the map sits inside either theme. */
const TILES = {
  light: {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  dark: {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
};

function MapModal({ rows, areaLabel, interested, onToggleInterest, onClose }) {
  const canvasRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef({});     // id -> Leaflet marker
  const listRef = useRef(null);
  const cardRefs = useRef({});       // id -> list-item element
  const [active, setActive] = useState(null);

  // Only homes we actually have a location for.
  const placed = useMemo(() => rows.filter((l) => l.lat != null && l.lng != null), [rows]);

  // Esc to close + lock background scroll.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, []);

  // Build the map once placed homes are known.
  useEffect(() => {
    if (!canvasRef.current || placed.length === 0 || !window.L) return;
    const theme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";

    const map = L.map(canvasRef.current, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: true,
    });
    mapRef.current = map;

    L.tileLayer(TILES[theme].url, {
      attribution: TILES[theme].attribution,
      subdomains: "abcd",
      maxZoom: 19,
    }).addTo(map);

    placed.forEach((l) => {
      const label = priceShort(l.price);
      const w = label.length * 8.5 + 22, h = 28;
      const icon = L.divIcon({
        className: "map-pin-anchor",
        html: `<button class="map-pin" type="button">${label}</button>`,
        iconSize: [w, h],
        iconAnchor: [w / 2, h + 7],
      });
      const m = L.marker([l.lat, l.lng], { icon, riseOnHover: true, title: l.address }).addTo(map);
      m.on("click", () => focusListing(l.id, false));
      markersRef.current[l.id] = m;
    });

    const bounds = L.latLngBounds(placed.map((l) => [l.lat, l.lng]));
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14 });

    // The modal sizes the canvas after mount — recompute once it's painted.
    const t = setTimeout(() => map.invalidateSize(), 60);

    return () => { clearTimeout(t); map.remove(); mapRef.current = null; markersRef.current = {}; };
  }, [placed]);

  // Reflect the active selection onto pins (lifted + accented).
  useEffect(() => {
    Object.entries(markersRef.current).forEach(([id, m]) => {
      const el = m.getElement && m.getElement();
      if (!el) return;
      const pin = el.querySelector(".map-pin");
      if (pin) pin.classList.toggle("is-active", id === active);
      if (id === active && m.setZIndexOffset) m.setZIndexOffset(1000);
      else if (m.setZIndexOffset) m.setZIndexOffset(0);
    });
  }, [active]);

  // Select a listing; optionally scroll its card into view inside the list.
  function focusListing(id, fromList) {
    setActive(id);
    const m = markersRef.current[id];
    const l = placed.find((x) => x.id === id);
    if (m && mapRef.current && l) {
      mapRef.current.panTo([l.lat, l.lng], { animate: true, duration: 0.4 });
    }
    if (!fromList) {
      const aside = listRef.current, card = cardRefs.current[id];
      if (aside && card) {
        aside.scrollTo({ top: card.offsetTop - aside.offsetTop - 12, behavior: "smooth" });
      }
    }
  }

  const counts = useMemo(() => ({ total: placed.length }), [placed]);

  return (
    <div className="modal-scrim modal-scrim--map" onMouseDown={onClose}>
      <div className="modal modal--map" role="dialog" aria-modal="true" aria-label="Homes on the map"
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <div>
            <span className="eyebrow"><Icon name="map-pin" size={13} /> Map</span>
            <h2 className="modal__title">
              {counts.total} {counts.total === 1 ? "home" : "homes"}{areaLabel ? ` · ${areaLabel}` : ""}
            </h2>
          </div>
          <button className="modal__close" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>

        <div className="mapmodal">
          <aside className="maplist" ref={listRef}>
            {placed.map((l) => (
              <div
                key={l.id}
                ref={(el) => { cardRefs.current[l.id] = el; }}
                className={`maprow${active === l.id ? " is-active" : ""}`}
                onClick={() => focusListing(l.id, true)}
              >
                <div className="maprow__photo">
                  <Icon name="image" size={20} />
                </div>
                <div className="maprow__body">
                  <div className="maprow__top">
                    <span className="maprow__price">{priceFull(l.price)}</span>
                    {!l.listingUrl && (
                      <span className="maprow__src"><Icon name="mail" size={12} /> Email only</span>
                    )}
                  </div>
                  <div className="maprow__addr">{l.address}</div>
                  <div className="maprow__meta">
                    <span>{l.postcode}</span>
                    {l.bedrooms != null && <span><Icon name="bed-double" size={13} /> {l.bedrooms}</span>}
                    {l.bathrooms != null && <span><Icon name="bath" size={13} /> {l.bathrooms}</span>}
                  </div>
                </div>
                <div className="maprow__right">
                  <ScoreRing value={l.score} size={34} />
                  <button
                    className={`intbtn intbtn--sm${interested.includes(l.id) ? " is-on" : ""}`}
                    onClick={(e) => { e.stopPropagation(); onToggleInterest(l.id); }}
                    aria-pressed={interested.includes(l.id)}
                    title={interested.includes(l.id) ? "Saved to follow-ups" : "I'm interested"}
                  >
                    <Icon name="bookmark" size={15} />
                  </button>
                </div>
              </div>
            ))}
          </aside>
          <div className="mapcanvas" ref={canvasRef}></div>
        </div>

        <div className="mapmodal__foot">
          <span className="map-foot-note">
            <Icon name="map-pin" size={13} /> Pins show the approximate area — open the source for the exact address
          </span>
          {active && (() => {
            const l = placed.find((x) => x.id === active);
            if (!l) return null;
            return l.listingUrl ? (
              <a className="hs-btn hs-btn--secondary hs-btn--sm" href={l.listingUrl} target="_blank" rel="noreferrer">
                <Icon name="external-link" size={15} /> View source
              </a>
            ) : (
              <span className="src-none src-none--foot"><Icon name="mail" size={14} /> Email only</span>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

window.MapModal = MapModal;
