/**
 * Unit tests for MapModal. Leaflet renders to a real DOM/canvas it expects a
 * browser for, so we stub the `leaflet` module here (the real map wiring is
 * proven in e2e/map.spec.ts) and stub the geocoder so placement is
 * deterministic. These tests cover the React surface: which homes get placed,
 * the title, selection → "View source", and the close affordances.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// Stub Leaflet — every method the modal calls is a no-op spy.
vi.mock("leaflet", () => {
  const marker = {
    addTo: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    getElement: vi.fn(() => null),
    setZIndexOffset: vi.fn(),
  };
  const map = {
    setView: vi.fn().mockReturnThis(),
    fitBounds: vi.fn(),
    panTo: vi.fn(),
    remove: vi.fn(),
    invalidateSize: vi.fn(),
  };
  return {
    default: {
      map: vi.fn(() => map),
      tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
      marker: vi.fn(() => marker),
      divIcon: vi.fn(() => ({})),
      latLngBounds: vi.fn(() => ({})),
    },
  };
});

const { geocodeMock } = vi.hoisted(() => ({ geocodeMock: vi.fn() }));
vi.mock("../lib/geocoding", () => ({
  normalizePostcode: (p: string) => p.trim().toUpperCase().replace(/\s+/g, " "),
  geocodePostcodes: geocodeMock,
}));

import { MapModal, type MapListing } from "./MapModal";

const ROWS: MapListing[] = [
  {
    id: "a",
    address: "rivington street se1",
    postcode: "SE1 1AA",
    price: 425000,
    bedrooms: 2,
    bathrooms: 1,
    score: 80,
    listingUrl: "https://x.test/a",
  },
  {
    id: "b",
    address: "deansgate m3",
    postcode: "M3 4LZ",
    price: 320000,
    bedrooms: 1,
    bathrooms: 1,
    score: 60,
    listingUrl: null,
  },
  {
    id: "c",
    address: "no postcode home",
    postcode: null,
    price: 500000,
    bedrooms: 3,
    bathrooms: 2,
    score: 70,
    listingUrl: "https://x.test/c",
  },
];

interface RenderOpts {
  rows?: MapListing[];
  areaLabel?: string | null;
  interested?: string[];
  onToggleInterest?: (id: string) => void;
  onClose?: () => void;
}

function renderModal(opts: RenderOpts = {}) {
  const onClose = opts.onClose ?? vi.fn();
  const onToggleInterest = opts.onToggleInterest ?? vi.fn();
  render(
    <MapModal
      rows={opts.rows ?? ROWS}
      areaLabel={opts.areaLabel ?? null}
      interested={opts.interested ?? []}
      onToggleInterest={onToggleInterest}
      onClose={onClose}
    />,
  );
  return { onClose, onToggleInterest };
}

describe("MapModal", () => {
  beforeEach(() => {
    geocodeMock.mockResolvedValue(
      new Map([
        ["SE1 1AA", { lat: 51.5, lng: -0.09 }],
        ["M3 4LZ", { lat: 53.47, lng: -2.25 }],
      ]),
    );
    localStorage.clear();
  });
  afterEach(() => {
    vi.clearAllMocks();
    document.body.style.overflow = "";
  });

  it("places only geocodable homes and counts them in the title", async () => {
    renderModal();
    const dialog = await screen.findByTestId("map-modal");
    // 2 of 3 rows geocode; the null-postcode home is dropped.
    await waitFor(() => expect(within(dialog).getAllByTestId("maprow")).toHaveLength(2));
    expect(within(dialog).getByRole("heading")).toHaveTextContent("2 homes");
    expect(within(dialog).queryByText("no postcode home")).toBeNull();
  });

  it("appends the area label to the heading when provided", async () => {
    renderModal({ areaLabel: "North Wales" });
    const dialog = await screen.findByTestId("map-modal");
    await waitFor(() =>
      expect(within(dialog).getByRole("heading")).toHaveTextContent("North Wales"),
    );
  });

  it("reveals a View source link for the selected home", async () => {
    renderModal();
    const dialog = await screen.findByTestId("map-modal");
    await waitFor(() => expect(within(dialog).getAllByTestId("maprow")).toHaveLength(2));

    fireEvent.click(within(dialog).getByText("rivington street se1"));
    const link = await within(dialog).findByTestId("map-source-link");
    expect(link).toHaveAttribute("href", "https://x.test/a");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("closes on Escape, scrim mousedown, and the close button", async () => {
    const { onClose } = renderModal();
    await screen.findByTestId("map-modal");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.mouseDown(screen.getByTestId("map-scrim"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("shows an empty state when none of the homes can be placed", async () => {
    geocodeMock.mockResolvedValue(new Map());
    renderModal({ rows: [ROWS[2]!] }); // only the null-postcode home
    const dialog = await screen.findByTestId("map-modal");
    await waitFor(() => expect(within(dialog).getByTestId("map-empty")).toBeInTheDocument());
  });

  it("does not re-geocode when the same homes are reordered", async () => {
    const props = {
      areaLabel: null,
      interested: [] as string[],
      onToggleInterest: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<MapModal rows={ROWS} {...props} />);
    const dialog = await screen.findByTestId("map-modal");
    await waitFor(() => expect(within(dialog).getAllByTestId("maprow")).toHaveLength(2));
    expect(geocodeMock).toHaveBeenCalledTimes(1);

    // Same homes, reversed order → the postcode key must be unchanged, so no
    // second geocode (and no Leaflet teardown/rebuild).
    rerender(<MapModal rows={[...ROWS].reverse()} {...props} />);
    await waitFor(() => expect(geocodeMock).toHaveBeenCalledTimes(1));
  });
});
