/**
 * AgentsPage unit tests — render the Agents screen with a mocked tRPC client and
 * assert the ported behaviour: rows render from the list query with status pills,
 * the four metric tiles read from the stats query, the status-filter chips narrow
 * the rows (and fold queued into awaiting), the drill-in banner shows when a
 * filter is set + its clear fires `onClearFilter`, and the empty state renders
 * when no rows come back.
 *
 * The tRPC client is mocked at the module boundary (vi.hoisted) so no backend/DB
 * is needed; the component is imported AFTER the mock.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const { listQueryMock, statsQueryMock } = vi.hoisted(() => ({
  listQueryMock: vi.fn(),
  statsQueryMock: vi.fn(),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    agents: {
      list: { useQuery: listQueryMock },
      stats: { useQuery: statsQueryMock },
    },
  },
}));

import { AgentsPage } from "./AgentsPage";

const NOW = new Date();

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-x",
    agencyName: "Finch & Co",
    email: "sales@finch.co.uk",
    outcodes: ["SE16", "SE1"],
    status: "awaiting" as const,
    homesCount: 0,
    lastContactedAt: NOW,
    ...overrides,
  };
}

const AGENTS = [
  makeAgent({
    id: "agent-replied",
    agencyName: "Field & Sons",
    email: "info@fieldandsons.co.uk",
    outcodes: ["SE16"],
    status: "replied",
    homesCount: 3,
  }),
  makeAgent({
    id: "agent-awaiting",
    agencyName: "Acorn",
    email: "bermondsey@acorn.ltd.uk",
    outcodes: ["SE16"],
    status: "awaiting",
    homesCount: 0,
  }),
  makeAgent({
    id: "agent-queued",
    agencyName: "Pedder",
    email: "bermondsey@pedderproperty.com",
    outcodes: ["SE1"],
    status: "queued",
    homesCount: 0,
    lastContactedAt: null,
  }),
  makeAgent({
    id: "agent-opted",
    agencyName: "Roy Brooks",
    email: "mail@roybrooks.co.uk",
    outcodes: ["SE15"],
    status: "opted_out",
    homesCount: 1,
  }),
];

const STATS = { contacted: 4, replied: 1, awaiting: 2, homesIngested: 4 };

function withAgents(agents: unknown[] = AGENTS) {
  listQueryMock.mockReturnValue({
    data: agents,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
}

function withStats(stats: unknown = STATS) {
  statsQueryMock.mockReturnValue({ data: stats });
}

beforeEach(() => {
  listQueryMock.mockReset();
  statsQueryMock.mockReset();
  withAgents();
  withStats();
});

describe("AgentsPage states", () => {
  it("shows a loading message while the query is pending", () => {
    listQueryMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    });
    render(<AgentsPage filter={null} onClearFilter={vi.fn()} />);
    expect(screen.getByText(/loading agents/i)).toBeInTheDocument();
    expect(screen.queryByTestId("agents-table")).not.toBeInTheDocument();
  });

  it("shows an error + Retry that calls refetch", () => {
    const refetch = vi.fn();
    listQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    render(<AgentsPage filter={null} onClearFilter={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn.t load agents/i);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state when there are no agents", () => {
    withAgents([]);
    render(<AgentsPage filter={null} onClearFilter={vi.fn()} />);
    expect(screen.getByTestId("agents-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("agents-table")).not.toBeInTheDocument();
  });
});

describe("AgentsPage rows + metrics", () => {
  it("renders one row per agent with a status pill, monogram, and email", () => {
    render(<AgentsPage filter={null} onClearFilter={vi.fn()} />);
    const rows = screen.getAllByTestId("agent-row");
    expect(rows).toHaveLength(4);
    // The replied agent shows its label + email; data-agency carries the name.
    const replied = rows.find((r) => r.dataset.agency === "Field & Sons")!;
    expect(replied).toHaveTextContent("Field & Sons");
    expect(replied).toHaveTextContent("info@fieldandsons.co.uk");
    expect(replied).toHaveTextContent(/Replied/);
    // Homes cell renders the count when > 0, an em dash when 0.
    expect(replied).toHaveTextContent("3");
    const awaiting = rows.find((r) => r.dataset.agency === "Acorn")!;
    expect(awaiting).toHaveTextContent("—");
  });

  it("rolls a multi-outcode agent's coverage up to region + count", () => {
    withAgents([
      makeAgent({
        id: "agent-wide",
        agencyName: "Wide Reach Estates",
        outcodes: ["SE16", "SE1", "SE15"],
        status: "replied",
      }),
    ]);
    render(<AgentsPage filter={null} onClearFilter={vi.fn()} />);
    const roll = screen.getByTestId("agent-coverage-roll");
    expect(roll).toHaveTextContent("South East London");
    expect(roll).toHaveTextContent("3 outcodes");
  });

  it("shows a single-outcode agent's coverage as a town + code, no rollup", () => {
    withAgents([makeAgent({ id: "agent-one", outcodes: ["SE16"] })]);
    render(<AgentsPage filter={null} onClearFilter={vi.fn()} />);
    const cov = screen.getByTestId("agent-coverage");
    expect(cov).toHaveTextContent("Bermondsey");
    expect(cov).toHaveTextContent("SE16");
    expect(screen.queryByTestId("agent-coverage-roll")).not.toBeInTheDocument();
  });

  it("renders the four metric tiles from the stats query", () => {
    render(<AgentsPage filter={null} onClearFilter={vi.fn()} />);
    expect(screen.getByTestId("agents-metric-contacted")).toHaveTextContent("4");
    expect(screen.getByTestId("agents-metric-replied")).toHaveTextContent("1");
    expect(screen.getByTestId("agents-metric-awaiting")).toHaveTextContent("2");
    expect(screen.getByTestId("agents-metric-homes")).toHaveTextContent("4");
  });

  it("scopes both queries to the filter's outcodes", () => {
    render(
      <AgentsPage
        filter={{ name: "Bermondsey", outcodes: ["SE16", "SE1"] }}
        onClearFilter={vi.fn()}
      />,
    );
    expect(listQueryMock).toHaveBeenCalledWith({ outcodes: ["SE16", "SE1"] });
    expect(statsQueryMock).toHaveBeenCalledWith({ outcodes: ["SE16", "SE1"] });
  });

  it("requests all agents (undefined outcodes) without a filter", () => {
    render(<AgentsPage filter={null} onClearFilter={vi.fn()} />);
    expect(listQueryMock).toHaveBeenCalledWith({ outcodes: undefined });
  });
});

describe("AgentsPage status filter", () => {
  it("defaults to All (every row) and the count reflects it", () => {
    render(<AgentsPage filter={null} onClearFilter={vi.fn()} />);
    expect(screen.getByTestId("agent-filter-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("agents-count")).toHaveTextContent("4");
  });

  it("narrows to replied agents on the Replied chip", () => {
    render(<AgentsPage filter={null} onClearFilter={vi.fn()} />);
    fireEvent.click(screen.getByTestId("agent-filter-replied"));
    const rows = screen.getAllByTestId("agent-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Field & Sons");
    expect(screen.getByTestId("agent-filter-replied")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("folds queued into the Awaiting chip", () => {
    render(<AgentsPage filter={null} onClearFilter={vi.fn()} />);
    fireEvent.click(screen.getByTestId("agent-filter-awaiting"));
    const rows = screen.getAllByTestId("agent-row");
    // Acorn (awaiting) + Pedder (queued) both qualify.
    expect(rows).toHaveLength(2);
    const agencies = rows.map((r) => r.dataset.agency).sort();
    expect(agencies).toEqual(["Acorn", "Pedder"]);
  });

  it("narrows to opted-out agents on the Opted out chip", () => {
    render(<AgentsPage filter={null} onClearFilter={vi.fn()} />);
    fireEvent.click(screen.getByTestId("agent-filter-opted_out"));
    const rows = screen.getAllByTestId("agent-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Roy Brooks");
  });
});

describe("AgentsPage drill-in banner", () => {
  it("hides the banner with no filter set", () => {
    render(<AgentsPage filter={null} onClearFilter={vi.fn()} />);
    expect(screen.queryByTestId("agent-filter-banner")).not.toBeInTheDocument();
  });

  it("shows the banner (name + outcodes) and clears via onClearFilter", () => {
    const onClearFilter = vi.fn();
    render(
      <AgentsPage
        filter={{ name: "Bermondsey family home", outcodes: ["SE16", "SE1"] }}
        onClearFilter={onClearFilter}
      />,
    );
    const banner = screen.getByTestId("agent-filter-banner");
    expect(banner).toHaveTextContent("Bermondsey family home");
    expect(banner).toHaveTextContent("SE16");
    expect(banner).toHaveTextContent("SE1");
    fireEvent.click(screen.getByTestId("agent-filter-clear"));
    expect(onClearFilter).toHaveBeenCalledTimes(1);
  });
});
