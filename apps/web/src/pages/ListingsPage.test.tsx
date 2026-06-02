/**
 * ListingsPage unit tests — render the screen with a mocked tRPC query and
 * assert the no-filter, sortable, dual-view behaviour ported from the design.
 *
 * The tRPC client is mocked at the module boundary so no backend/DB is needed;
 * `useQueryMock` controls each test's loading/error/data state.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const { useQueryMock } = vi.hoisted(() => ({ useQueryMock: vi.fn() }));
vi.mock("../lib/trpc", () => ({
  trpc: { listings: { list: { useQuery: useQueryMock } } },
}));

import { ListingsPage } from "./ListingsPage";

const NOW = new Date("2026-01-10T12:00:00.000Z");

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "id-" + (overrides.addressNormalized ?? "x"),
    addressNormalized: "a road",
    postcode: "SE1 1AA",
    outcode: "SE1",
    pricePence: 50_000_000,
    bedrooms: 2,
    tenure: null,
    propertyType: "terraced",
    epcRating: "c",
    listingStatus: "live",
    isPreMarket: false,
    listingUrl: "https://x.test/a",
    primarySource: "agent_email",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    combinedScore: 0.6,
    ...overrides,
  };
}

// alpha: high price, mid score, has a source URL
// bravo: low price, top score, pre-market (no URL)
// charlie: mid price, unscored, has a source URL
const ITEMS = [
  makeItem({
    addressNormalized: "alpha road",
    pricePence: 70_000_000,
    combinedScore: 0.6,
    listingStatus: "live",
    listingUrl: "https://x.test/alpha",
    propertyType: "terraced",
  }),
  makeItem({
    addressNormalized: "bravo street",
    pricePence: 40_000_000,
    combinedScore: 0.9,
    listingStatus: "pre_market",
    isPreMarket: true,
    listingUrl: null,
    propertyType: "semi_detached",
    epcRating: null,
  }),
  makeItem({
    addressNormalized: "charlie lane",
    pricePence: 50_000_000,
    combinedScore: null,
    listingStatus: "live",
    listingUrl: "https://x.test/charlie",
    propertyType: "flat",
  }),
];

function withData(items: unknown[] = ITEMS, nextCursor: string | null = null) {
  useQueryMock.mockReturnValue({
    data: { items, nextCursor },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
}

function renderedAddresses(): string[] {
  return screen
    .getAllByTestId("listing-row")
    .map((r) => r.getAttribute("data-address") ?? "");
}

describe("ListingsPage states", () => {
  it("shows a loading message while the query is pending", () => {
    useQueryMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    });
    render(<ListingsPage />);
    expect(screen.getByText(/loading listings/i)).toBeInTheDocument();
    expect(screen.queryByTestId("listings-table")).not.toBeInTheDocument();
  });

  it("shows an error + Retry that calls refetch", () => {
    const refetch = vi.fn();
    useQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    render(<ListingsPage />);
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn.t load listings/i);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state when there are no listings", () => {
    withData([]);
    render(<ListingsPage />);
    expect(screen.getByTestId("listings-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("listing-row")).not.toBeInTheDocument();
  });
});

describe("ListingsPage table", () => {
  it("renders one row per listing with no filter controls", () => {
    withData();
    render(<ListingsPage />);
    expect(screen.getByTestId("listings-table")).toBeInTheDocument();
    expect(screen.getAllByTestId("listing-row")).toHaveLength(3);
    // No filters in the design — none of the old filter inputs exist.
    expect(screen.queryByTestId("filter-outcode")).not.toBeInTheDocument();
    expect(screen.queryByTestId("filter-max-price")).not.toBeInTheDocument();
    expect(screen.queryByTestId("filter-min-beds")).not.toBeInTheDocument();
  });

  it("defaults to match-score-descending order (unscored sinks)", () => {
    withData();
    render(<ListingsPage />);
    expect(renderedAddresses()).toEqual(["bravo street", "alpha road", "charlie lane"]);
  });

  it("renders the match score (0–100) and a placeholder for unscored", () => {
    withData();
    render(<ListingsPage />);
    expect(screen.getAllByTestId("match-score")).toHaveLength(3);
    expect(screen.getByText("90")).toBeInTheDocument(); // bravo 0.9 → 90
    expect(screen.getByText("60")).toBeInTheDocument(); // alpha 0.6 → 60
    expect(screen.getByText("–")).toBeInTheDocument(); // charlie unscored
  });

  it("counts homes + pre-market in the control bar", () => {
    withData();
    render(<ListingsPage />);
    const count = screen.getByTestId("listings-count");
    expect(count).toHaveTextContent("3");
    expect(count).toHaveTextContent("1 pre-market");
  });

  it("renders a source link for listed homes and an email-only marker for pre-market", () => {
    withData();
    render(<ListingsPage />);
    expect(screen.getAllByTestId("listing-source-link")).toHaveLength(2);
    const noneCells = screen.getAllByTestId("listing-source-none");
    expect(noneCells).toHaveLength(1);
    const link = screen.getAllByTestId("listing-source-link")[0]!;
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });
});

describe("ListingsPage sorting", () => {
  it("re-sorts by price descending from the dropdown", () => {
    withData();
    render(<ListingsPage />);
    fireEvent.change(screen.getByTestId("sort-by"), { target: { value: "price" } });
    expect(renderedAddresses()).toEqual(["alpha road", "charlie lane", "bravo street"]);
  });

  it("toggles direction when a column header is clicked twice", () => {
    withData();
    render(<ListingsPage />);
    // First click on the Price column header → default desc. (Scope to the
    // header — "Price" is also a <option> label in the sort dropdown.)
    const priceHeader = screen.getByRole("columnheader", { name: "Price" });
    fireEvent.click(priceHeader);
    expect(renderedAddresses()).toEqual(["alpha road", "charlie lane", "bravo street"]);
    // Second click flips to asc.
    fireEvent.click(priceHeader);
    expect(renderedAddresses()).toEqual(["bravo street", "charlie lane", "alpha road"]);
  });
});

describe("ListingsPage view toggle", () => {
  it("switches to the card grid and persists the choice", () => {
    withData();
    render(<ListingsPage />);
    expect(screen.getByTestId("listings-table")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("view-cards"));
    expect(screen.queryByTestId("listings-table")).not.toBeInTheDocument();
    expect(document.querySelector(".grid-cards")).not.toBeNull();
    expect(screen.getAllByTestId("listing-row")).toHaveLength(3);
    expect(localStorage.getItem("hs-view")).toBe("cards");
  });
});
