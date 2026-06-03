/**
 * ListingsPage unit tests — render the screen with a mocked tRPC query and
 * assert the no-filter, sortable, dual-view behaviour ported from the 2nd
 * design handoff: no listing status, a real Agent column, beds/baths, and the
 * bookmark → interest-bar → per-agency follow-up flow.
 *
 * The tRPC client is mocked at the module boundary so no backend/DB is needed;
 * `useQueryMock` controls each test's loading/error/data state. localStorage is
 * reset between tests so the bookmark persistence ("hs-interested") starts clean.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const { useQueryMock } = vi.hoisted(() => ({ useQueryMock: vi.fn() }));
vi.mock("../lib/trpc", () => ({
  trpc: {
    listings: { list: { useQuery: useQueryMock } },
    outreach: { senderName: { useQuery: () => ({ data: { name: "Bryan" } }) } },
  },
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
    bathrooms: 1,
    tenure: null,
    propertyType: "terraced",
    epcRating: "c",
    listingStatus: "live",
    isPreMarket: false,
    listingUrl: "https://x.test/a",
    primarySource: "agent_email",
    agentEmail: "agent@a.test",
    agency: "Acme Estates",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    combinedScore: 0.6,
    ...overrides,
  };
}

// alpha: high price, mid score, has a source URL, Acme Estates
// bravo: low price, top score, email-only (no URL), Bravo Homes, no baths/beds
// charlie: mid price, unscored, has a source URL, Acme Estates (shares alpha's agency)
const ITEMS = [
  makeItem({
    addressNormalized: "alpha road",
    pricePence: 70_000_000,
    combinedScore: 0.6,
    bedrooms: 3,
    bathrooms: 2,
    listingUrl: "https://x.test/alpha",
    propertyType: "terraced",
    agency: "Acme Estates",
    agentEmail: "alpha@acme.test",
  }),
  makeItem({
    addressNormalized: "bravo street",
    pricePence: 40_000_000,
    combinedScore: 0.9,
    bedrooms: null,
    bathrooms: null,
    listingUrl: null,
    propertyType: "semi_detached",
    epcRating: null,
    agency: "Bravo Homes",
    agentEmail: "bravo@bravo.test",
  }),
  makeItem({
    addressNormalized: "charlie lane",
    pricePence: 50_000_000,
    combinedScore: null,
    bedrooms: 2,
    bathrooms: 1,
    listingUrl: "https://x.test/charlie",
    propertyType: "flat",
    agency: "Acme Estates",
    agentEmail: "charlie@acme.test",
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

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

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

  it("renders a source link for listed homes and an email-only marker otherwise", () => {
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

describe("ListingsPage status removal", () => {
  it("counts homes as 'from your agents' with no pre-market count", () => {
    withData();
    render(<ListingsPage />);
    const count = screen.getByTestId("listings-count");
    expect(count).toHaveTextContent("3");
    expect(count).toHaveTextContent(/homes from your agents/i);
    expect(count).not.toHaveTextContent(/pre-market/i);
  });

  it("renders no Status column header and no status badge text", () => {
    withData();
    render(<ListingsPage />);
    expect(
      screen.queryByRole("columnheader", { name: /status/i }),
    ).not.toBeInTheDocument();
    // The old StatusBadge labels must be gone everywhere.
    expect(screen.queryByText("Pre-market")).not.toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
    expect(screen.queryByText("Under offer")).not.toBeInTheDocument();
  });
});

describe("ListingsPage agent + beds/baths", () => {
  it("renders the Agent column with the agency name", () => {
    withData();
    render(<ListingsPage />);
    expect(screen.getByRole("columnheader", { name: "Agent" })).toBeInTheDocument();
    expect(screen.getAllByText("Acme Estates")).toHaveLength(2); // alpha + charlie
    expect(screen.getByText("Bravo Homes")).toBeInTheDocument(); // bravo
  });

  it("falls back to an em-dash when an agency is missing", () => {
    withData([
      makeItem({ addressNormalized: "no agent road", agency: null, agentEmail: null }),
    ]);
    render(<ListingsPage />);
    const row = screen.getByTestId("listing-row");
    expect(within(row).getByText("—")).toBeInTheDocument();
  });

  it("shows beds + baths, and an em-dash for land/no-beds rows", () => {
    withData();
    render(<ListingsPage />);
    const alpha = screen
      .getAllByTestId("listing-row")
      .find((r) => r.getAttribute("data-address") === "alpha road")!;
    expect(within(alpha).getByText("3")).toBeInTheDocument(); // beds
    expect(within(alpha).getByText("2")).toBeInTheDocument(); // baths
    const bravo = screen
      .getAllByTestId("listing-row")
      .find((r) => r.getAttribute("data-address") === "bravo street")!;
    // bravo has null bedrooms → the bedbath cell collapses to an em-dash.
    expect(within(bravo).getByText("—")).toBeInTheDocument();
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

describe("ListingsPage interest + follow-ups", () => {
  it("has a bookmark on every row and shows no interest bar initially", () => {
    withData();
    render(<ListingsPage />);
    expect(screen.getAllByTestId("interest-button")).toHaveLength(3);
    expect(screen.queryByTestId("interest-bar")).not.toBeInTheDocument();
  });

  it("toggling a bookmark reveals the interest bar and persists to localStorage", () => {
    withData();
    render(<ListingsPage />);
    fireEvent.click(screen.getAllByTestId("interest-button")[0]!);

    const bar = screen.getByTestId("interest-bar");
    expect(bar).toHaveTextContent("1");
    expect(bar).toHaveTextContent(/home you're interested in/i);
    // bravo sorts first (top score) → its id is the one stored.
    expect(JSON.parse(localStorage.getItem("hs-interested") ?? "[]")).toEqual([
      "id-bravo street",
    ]);

    // Un-bookmark → the bar disappears again.
    fireEvent.click(screen.getAllByTestId("interest-button")[0]!);
    expect(screen.queryByTestId("interest-bar")).not.toBeInTheDocument();
  });

  it("rehydrates bookmarks from localStorage on mount", () => {
    localStorage.setItem("hs-interested", JSON.stringify(["id-alpha road"]));
    withData();
    render(<ListingsPage />);
    expect(screen.getByTestId("interest-bar")).toHaveTextContent("1");
  });

  it("'Clear' empties the bookmarks and hides the bar", () => {
    withData();
    render(<ListingsPage />);
    fireEvent.click(screen.getAllByTestId("interest-button")[0]!);
    fireEvent.click(screen.getByText("Clear"));
    expect(screen.queryByTestId("interest-bar")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("hs-interested") ?? "[]")).toEqual([]);
  });

  it("'Draft follow-ups' opens a modal grouping the bookmarked homes by agency", () => {
    // Bookmark alpha + charlie (both Acme Estates) and bravo (Bravo Homes).
    localStorage.setItem(
      "hs-interested",
      JSON.stringify(["id-alpha road", "id-charlie lane", "id-bravo street"]),
    );
    withData();
    render(<ListingsPage />);

    fireEvent.click(screen.getByTestId("draft-followups"));
    const modal = screen.getByTestId("followup-modal");
    expect(modal).toBeInTheDocument();

    // Two agencies → two groups (Acme covers two homes, Bravo one).
    const groups = screen.getAllByTestId("followup-group");
    expect(groups).toHaveLength(2);
    expect(within(modal).getByText("Acme Estates")).toBeInTheDocument();
    expect(within(modal).getByText("Bravo Homes")).toBeInTheDocument();
    // The Acme group lists both of its homes in one note.
    const acme = groups.find((g) => within(g).queryByText("Acme Estates"))!;
    expect(within(acme).getByText("2 homes")).toBeInTheDocument();
    // The title counts agents, not homes.
    expect(within(modal).getByText(/tell 2 agents you're interested/i)).toBeInTheDocument();
  });

  it("'Send' is a mock that flips to the sent success state", () => {
    localStorage.setItem("hs-interested", JSON.stringify(["id-alpha road"]));
    withData();
    render(<ListingsPage />);

    fireEvent.click(screen.getByTestId("draft-followups"));
    fireEvent.click(screen.getByTestId("followup-send"));
    expect(screen.getByTestId("followup-sent")).toBeInTheDocument();
    expect(screen.getByText(/sent to 1 agent/i)).toBeInTheDocument();
  });

  it("falls back to 'your agent' when grouping a home with no agency", () => {
    localStorage.setItem("hs-interested", JSON.stringify(["id-no agent road"]));
    withData([
      makeItem({ addressNormalized: "no agent road", agency: null, agentEmail: null }),
    ]);
    render(<ListingsPage />);

    fireEvent.click(screen.getByTestId("draft-followups"));
    const modal = screen.getByTestId("followup-modal");
    expect(within(modal).getByText("your agent")).toBeInTheDocument();
  });
});
