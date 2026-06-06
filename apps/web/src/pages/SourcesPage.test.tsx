/**
 * SourcesPage unit tests — render the read-only Sources screen with a mocked
 * tRPC query and assert: the three metric tiles derive from the rows, one row
 * per catalogue source with its name + site host + "View N lots" + latest-lot
 * relative time, the gold-gavel (auction) / green-trees (land) marks, the
 * kind-filter chips narrow the table, and the "View N lots" drill-out fires
 * `onViewLots` with the source's drill-in shape. Sources is read-only, so there
 * is NO mutation mock and NO inbound-filter banner.
 *
 * The tRPC client is mocked at the module boundary (vi.hoisted) so no backend/DB
 * is needed; the component is imported AFTER the mock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const { listQueryMock, refreshMutationMock } = vi.hoisted(() => ({
  listQueryMock: vi.fn(),
  refreshMutationMock: vi.fn(),
}));
vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ sources: { list: { invalidate: vi.fn() } } }),
    sources: {
      list: { useQuery: listQueryMock },
      refresh: { useMutation: refreshMutationMock },
    },
  },
}));

import { SourcesPage } from "./SourcesPage";

const NOW = new Date();
const OLDER = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);

function makeSource(overrides: Record<string, unknown> = {}) {
  return {
    id: "auctionhouse",
    name: "Auction House",
    kind: "auction" as const,
    domain: "auctionhouse.co.uk",
    coverageOutcodes: ["LL2", "LL3"],
    coverageLabel: "North Wales",
    lotsFound: 5,
    latestObservedAt: NOW as Date | null,
    ...overrides,
  };
}

const SOURCES = [
  makeSource({
    id: "auctionhouse",
    name: "Auction House",
    kind: "auction",
    domain: "auctionhouse.co.uk",
    lotsFound: 5,
    latestObservedAt: NOW,
  }),
  makeSource({
    id: "uklandandfarms",
    name: "UK Land & Farms",
    kind: "land",
    domain: "uklandandfarms.co.uk",
    lotsFound: 2,
    latestObservedAt: OLDER,
  }),
];

function withSources(rows: unknown[] = SOURCES) {
  listQueryMock.mockReturnValue({
    data: rows,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
}

beforeEach(() => {
  listQueryMock.mockReset();
  refreshMutationMock.mockReset();
  refreshMutationMock.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
  });
  withSources();
});

describe("SourcesPage states", () => {
  it("shows a loading message while the query is pending", () => {
    listQueryMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    });
    render(<SourcesPage onViewLots={vi.fn()} />);
    expect(screen.getByText(/loading sources/i)).toBeInTheDocument();
    expect(screen.queryByTestId("sources-table")).not.toBeInTheDocument();
  });

  it("shows an error + Retry that calls refetch", () => {
    const refetch = vi.fn();
    listQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    render(<SourcesPage onViewLots={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn.t load sources/i);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state when there are no sources", () => {
    withSources([]);
    render(<SourcesPage onViewLots={vi.fn()} />);
    expect(screen.getByTestId("sources-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("sources-table")).not.toBeInTheDocument();
  });
});

describe("SourcesPage rows + metrics", () => {
  it("renders one row per source with its name, site host, lots link, and latest lot", () => {
    render(<SourcesPage onViewLots={vi.fn()} />);
    const rows = screen.getAllByTestId("source-row");
    expect(rows).toHaveLength(2);

    const auction = rows.find((r) => r.dataset.source === "auctionhouse")!;
    expect(auction).toHaveTextContent("Auction House");
    expect(within(auction).getByText("auctionhouse.co.uk")).toBeInTheDocument();
    expect(within(auction).getByTestId("source-lots-link")).toHaveTextContent(
      "View 5 listings",
    );

    const land = rows.find((r) => r.dataset.source === "uklandandfarms")!;
    expect(land).toHaveTextContent("UK Land & Farms");
    expect(within(land).getByTestId("source-lots-link")).toHaveTextContent(
      "View 2 listings",
    );
  });

  it("renders the gold-gavel mark on auction rows and the trees mark on land rows", () => {
    const { container } = render(<SourcesPage onViewLots={vi.fn()} />);
    const rows = screen.getAllByTestId("source-row");
    const auction = rows.find((r) => r.dataset.source === "auctionhouse")!;
    const land = rows.find((r) => r.dataset.source === "uklandandfarms")!;
    expect(auction.querySelector(".src-mark--auction")).not.toBeNull();
    expect(land.querySelector(".src-mark--land")).not.toBeNull();
    // Sanity: the page rendered exactly one of each kind of mark.
    expect(container.querySelectorAll(".src-mark--auction")).toHaveLength(1);
    expect(container.querySelectorAll(".src-mark--land")).toHaveLength(1);
  });

  it("shows the coverage label + outcode chips per source", () => {
    render(<SourcesPage onViewLots={vi.fn()} />);
    const auction = screen
      .getAllByTestId("source-row")
      .find((r) => r.dataset.source === "auctionhouse")!;
    expect(auction).toHaveTextContent("North Wales");
    expect(within(auction).getByText("LL2")).toBeInTheDocument();
    expect(within(auction).getByText("LL3")).toBeInTheDocument();
  });

  it("derives the three metric tiles from the rows", () => {
    render(<SourcesPage onViewLots={vi.fn()} />);
    // monitored sources = row count
    expect(screen.getByTestId("sources-metric-sources")).toHaveTextContent("2");
    // total lots = sum of lotsFound (5 + 2)
    expect(screen.getByTestId("sources-metric-lots")).toHaveTextContent("7");
    // latest activity = a relative time (max latestObservedAt = NOW)
    expect(screen.getByTestId("sources-metric-latest")).toHaveTextContent(/ago|now/i);
  });

  it("shows an em-dash for latest activity when no source has observed a lot", () => {
    withSources([
      makeSource({ id: "auctionhouse", lotsFound: 0, latestObservedAt: null }),
      makeSource({
        id: "uklandandfarms",
        kind: "land",
        domain: "uklandandfarms.co.uk",
        lotsFound: 0,
        latestObservedAt: null,
      }),
    ]);
    render(<SourcesPage onViewLots={vi.fn()} />);
    expect(screen.getByTestId("sources-metric-latest")).toHaveTextContent("—");
    expect(screen.getByTestId("sources-metric-lots")).toHaveTextContent("0");
  });

  it("counts the sources in the controls row", () => {
    render(<SourcesPage onViewLots={vi.fn()} />);
    expect(screen.getByTestId("sources-count")).toHaveTextContent("2");
  });
});

describe("SourcesPage kind filter", () => {
  it("defaults to All (every row) with the chip pressed", () => {
    render(<SourcesPage onViewLots={vi.fn()} />);
    expect(screen.getByTestId("source-filter-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getAllByTestId("source-row")).toHaveLength(2);
  });

  it("narrows to auction houses on the Auction chip and toggles aria-pressed", () => {
    render(<SourcesPage onViewLots={vi.fn()} />);
    fireEvent.click(screen.getByTestId("source-filter-auction"));
    const rows = screen.getAllByTestId("source-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dataset.source).toBe("auctionhouse");
    expect(screen.getByTestId("source-filter-auction")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("source-filter-all")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("narrows to land & farm on the Land chip", () => {
    render(<SourcesPage onViewLots={vi.fn()} />);
    fireEvent.click(screen.getByTestId("source-filter-land"));
    const rows = screen.getAllByTestId("source-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dataset.source).toBe("uklandandfarms");
  });

  it("restores both rows on the All chip", () => {
    render(<SourcesPage onViewLots={vi.fn()} />);
    fireEvent.click(screen.getByTestId("source-filter-auction"));
    expect(screen.getAllByTestId("source-row")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("source-filter-all"));
    expect(screen.getAllByTestId("source-row")).toHaveLength(2);
  });
});

describe("SourcesPage operator refresh", () => {
  it("hides the Refresh listings control for a non-operator", () => {
    render(<SourcesPage onViewLots={vi.fn()} />); // isOperator defaults false
    expect(screen.queryByTestId("sources-refresh")).not.toBeInTheDocument();
  });

  it("operator sees Refresh listings and clicking it fires the mutation", () => {
    const mutate = vi.fn();
    refreshMutationMock.mockReturnValue({
      mutate,
      isPending: false,
      isSuccess: false,
      isError: false,
      error: null,
    });
    render(<SourcesPage onViewLots={vi.fn()} isOperator />);
    fireEvent.click(screen.getByTestId("sources-refresh"));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("shows the queued note after a successful refresh", () => {
    refreshMutationMock.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      isSuccess: true,
      isError: false,
      error: null,
    });
    render(<SourcesPage onViewLots={vi.fn()} isOperator />);
    expect(screen.getByTestId("sources-refresh-status")).toBeInTheDocument();
  });

  it("disables the button while the refresh is pending", () => {
    refreshMutationMock.mockReturnValue({
      mutate: vi.fn(),
      isPending: true,
      isSuccess: false,
      isError: false,
      error: null,
    });
    render(<SourcesPage onViewLots={vi.fn()} isOperator />);
    expect(screen.getByTestId("sources-refresh")).toBeDisabled();
    expect(screen.getByTestId("sources-refresh")).toHaveTextContent(
      /refreshing/i,
    );
  });
});

describe("SourcesPage drill-out", () => {
  it("calls onViewLots with the source's drill-in shape when View N lots is clicked", () => {
    const onViewLots = vi.fn();
    render(<SourcesPage onViewLots={onViewLots} />);
    const auction = screen
      .getAllByTestId("source-row")
      .find((r) => r.dataset.source === "auctionhouse")!;
    fireEvent.click(within(auction).getByTestId("source-lots-link"));
    expect(onViewLots).toHaveBeenCalledTimes(1);
    expect(onViewLots).toHaveBeenCalledWith({
      id: "auctionhouse",
      name: "Auction House",
      kind: "auction",
      domain: "auctionhouse.co.uk",
    });
  });
});
