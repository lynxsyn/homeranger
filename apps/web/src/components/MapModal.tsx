/**
 * MapModal — "homes on a map". Plots the (filtered) listings at their postcode's
 * approximate location with brand price pins, beside a synced list; selecting a
 * home pans the map + lifts its pin and offers a link to the agent's source page.
 *
 * A faithful port of the design's map.jsx onto real data, with two deliberate
 * departures: postcodes are geocoded client-side (the DB has no lat/lng), and
 * the design's pre-market gold pins/notes are dropped — listing status is not
 * surfaced in this product (it is not scraped, so it would be guesswork).
 *
 * Leaflet is driven imperatively (the design's marker/active-sync logic ports
 * 1:1 and react-leaflet would fight it). apps/web is moduleResolution=bundler →
 * relative imports carry NO `.js`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import type { Map as LeafletMap, Marker as LeafletMarker } from "leaflet";
import "leaflet/dist/leaflet.css";
import { Icon } from "./Icon";
import { ScoreRing } from "./ui";
import { gbp } from "../lib/format";
import { basemapFor } from "../lib/basemap";
import { geocodePostcodes, normalizePostcode } from "../lib/geocoding";

export interface MapListing {
  id: string;
  address: string;
  postcode: string | null;
  price: number | null; // whole pounds
  bedrooms: number | null;
  bathrooms: number | null;
  score: number | null; // 0–100 match score
  listingUrl: string | null;
}

type PlacedListing = MapListing & { lat: number; lng: number };

export interface MapModalProps {
  rows: MapListing[];
  /** A search's name when the list is scoped to one (shown in the title). */
  areaLabel?: string | null;
  interested: string[];
  onToggleInterest: (id: string) => void;
  onClose: () => void;
}

/** Compact price for the pins (£625k, £1.2m); the list shows the full £. */
function priceShort(pounds: number | null): string {
  if (pounds == null) {
    return "POA";
  }
  if (pounds >= 1_000_000) {
    return "£" + (pounds / 1_000_000).toFixed(pounds % 1_000_000 === 0 ? 0 : 1) + "m";
  }
  return "£" + Math.round(pounds / 1000) + "k";
}

function currentTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export function MapModal({
  rows,
  areaLabel,
  interested,
  onToggleInterest,
  onClose,
}: MapModalProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef<Record<string, LeafletMarker>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [placed, setPlaced] = useState<PlacedListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<string | null>(null);

  // A stable key over the homes' DISTINCT postcodes so geocoding runs once per
  // distinct set. Sorted + de-duped so re-sorting the underlying list (same
  // homes, new order) does NOT re-trigger a geocode + Leaflet teardown/rebuild.
  const pcKey = useMemo(
    () => [...new Set(rows.map((r) => r.postcode ?? "").filter(Boolean))].sort().join(","),
    [rows],
  );

  // Esc to close + lock background scroll.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  // Geocode the homes' postcodes → keep only the ones we can place.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void geocodePostcodes(rows.map((r) => r.postcode)).then((coords) => {
      if (cancelled) {
        return;
      }
      const next: PlacedListing[] = [];
      for (const r of rows) {
        const ll = r.postcode ? coords.get(normalizePostcode(r.postcode)) : undefined;
        if (ll) {
          next.push({ ...r, lat: ll.lat, lng: ll.lng });
        }
      }
      setPlaced(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [pcKey]);

  // Select a home; optionally scroll its list card into view. Declared before
  // the map effect (function hoisting) so marker click handlers can call it.
  function focusListing(id: string, fromList: boolean) {
    setActive(id);
    const l = placed.find((x) => x.id === id);
    if (l && mapRef.current) {
      mapRef.current.panTo([l.lat, l.lng], { animate: true, duration: 0.4 });
    }
    if (!fromList) {
      const aside = listRef.current;
      const card = cardRefs.current[id];
      if (aside && card) {
        aside.scrollTo({ top: card.offsetTop - aside.offsetTop - 12, behavior: "smooth" });
      }
    }
  }

  // Build the Leaflet map once we have placed homes.
  useEffect(() => {
    if (!canvasRef.current || placed.length === 0) {
      return;
    }
    const tiles = basemapFor(currentTheme());
    const map = L.map(canvasRef.current, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: true,
    });
    mapRef.current = map;

    L.tileLayer(tiles.url, {
      attribution: tiles.attribution,
      subdomains: tiles.subdomains ?? "abc",
      maxZoom: tiles.maxZoom,
    }).addTo(map);

    for (const l of placed) {
      const label = priceShort(l.price);
      const w = label.length * 8.5 + 22;
      const h = 28;
      const icon = L.divIcon({
        className: "map-pin-anchor",
        html: `<button class="map-pin" type="button">${label}</button>`,
        iconSize: [w, h],
        iconAnchor: [w / 2, h + 7],
      });
      const marker = L.marker([l.lat, l.lng], {
        icon,
        riseOnHover: true,
        title: l.address,
      }).addTo(map);
      marker.on("click", () => focusListing(l.id, false));
      markersRef.current[l.id] = marker;
    }

    const bounds = L.latLngBounds(placed.map((l) => [l.lat, l.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14 });

    const t = window.setTimeout(() => map.invalidateSize(), 60);

    return () => {
      window.clearTimeout(t);
      map.remove();
      mapRef.current = null;
      markersRef.current = {};
    };
  }, [placed]);

  // Reflect the active selection onto the pins (lifted + accented).
  useEffect(() => {
    for (const [id, marker] of Object.entries(markersRef.current)) {
      const el = marker.getElement();
      const pin = el?.querySelector(".map-pin");
      pin?.classList.toggle("is-active", id === active);
      marker.setZIndexOffset(id === active ? 1000 : 0);
    }
  }, [active]);

  const count = placed.length;
  const heading = `${count} ${count === 1 ? "home" : "homes"}${
    areaLabel ? ` · ${areaLabel}` : ""
  }`;
  const activeListing = active ? placed.find((x) => x.id === active) ?? null : null;

  return (
    <div
      className="modal-scrim modal-scrim--map"
      data-testid="map-scrim"
      onMouseDown={onClose}
    >
      <div
        className="modal modal--map"
        role="dialog"
        aria-modal="true"
        aria-label="Homes on the map"
        data-testid="map-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <div>
            <span className="eyebrow">
              <Icon name="map-pin" size={13} /> Map
            </span>
            <h2 className="modal__title">{heading}</h2>
          </div>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </div>

        {loading ? (
          <div className="mapmodal mapmodal--state">
            <p className="map-state">Locating homes…</p>
          </div>
        ) : placed.length === 0 ? (
          <div className="mapmodal mapmodal--state">
            <p className="map-state" data-testid="map-empty">
              We couldn&rsquo;t place these homes on a map — their postcodes
              didn&rsquo;t resolve.
            </p>
          </div>
        ) : (
          <div className="mapmodal">
            <aside className="maplist" ref={listRef}>
              {placed.map((l) => {
                const on = interested.includes(l.id);
                return (
                  <div
                    key={l.id}
                    ref={(el) => {
                      cardRefs.current[l.id] = el;
                    }}
                    className={`maprow${active === l.id ? " is-active" : ""}`}
                    data-testid="maprow"
                    onClick={() => focusListing(l.id, true)}
                  >
                    <div className="maprow__photo">
                      <Icon name="image" size={20} />
                    </div>
                    <div className="maprow__body">
                      <div className="maprow__top">
                        <span className="maprow__price">{gbp(l.price)}</span>
                      </div>
                      <div className="maprow__addr">{l.address}</div>
                      <div className="maprow__meta">
                        {l.postcode && <span>{l.postcode}</span>}
                        {l.bedrooms != null && (
                          <span>
                            <Icon name="bed-double" size={13} /> {l.bedrooms}
                          </span>
                        )}
                        {l.bathrooms != null && (
                          <span>
                            <Icon name="bath" size={13} /> {l.bathrooms}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="maprow__right">
                      <ScoreRing value={l.score} size={34} />
                      <button
                        type="button"
                        className={`intbtn intbtn--sm${on ? " is-on" : ""}`}
                        data-testid="map-interest-button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleInterest(l.id);
                        }}
                        aria-pressed={on}
                        title={on ? "Saved to follow-ups" : "I'm interested"}
                      >
                        <Icon name="bookmark" size={15} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </aside>
            <div className="mapcanvas" data-testid="map-canvas" ref={canvasRef} />
          </div>
        )}

        <div className="mapmodal__foot">
          <span className="map-foot-note">
            <Icon name="map-pin" size={13} /> Pins show the approximate area — open
            the source for the exact address
          </span>
          {activeListing &&
            (activeListing.listingUrl ? (
              <a
                className="hs-btn hs-btn--secondary hs-btn--sm"
                data-testid="map-source-link"
                href={activeListing.listingUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="external-link" size={15} /> View source
              </a>
            ) : (
              <span
                className="src-none src-none--foot"
                data-testid="map-source-none"
              >
                <Icon name="mail" size={14} /> Email only
              </span>
            ))}
        </div>
      </div>
    </div>
  );
}
