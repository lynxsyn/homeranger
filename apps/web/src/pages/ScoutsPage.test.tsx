/**
 * ScoutsPage unit tests — render the Scouts screen with a mocked tRPC client
 * and assert the ported behaviour: cards render from the list query, the editor
 * opens + toggles chip-selects + interpolates the live email preview, pausing
 * asks first (confirm modal) while resuming is instant, and the "View homes"
 * link-through fires `onViewHomes` with the scout's outcodes.
 *
 * The tRPC client is mocked at the module boundary (vi.hoisted) so no
 * backend/DB is needed; `listQueryMock` controls the list state and the
 * mutation `.mutate` spies record the wire payloads.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const {
  listQueryMock,
  invalidateMock,
  createMutateMock,
  updateMutateMock,
  deleteMutateMock,
  setStatusMutateMock,
} = vi.hoisted(() => ({
  listQueryMock: vi.fn(),
  invalidateMock: vi.fn(),
  createMutateMock: vi.fn(),
  updateMutateMock: vi.fn(),
  deleteMutateMock: vi.fn(),
  setStatusMutateMock: vi.fn(),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ scouts: { list: { invalidate: invalidateMock } } }),
    scouts: {
      list: { useQuery: listQueryMock },
      create: { useMutation: () => ({ mutate: createMutateMock, isPending: false }) },
      update: { useMutation: () => ({ mutate: updateMutateMock, isPending: false }) },
      delete: { useMutation: () => ({ mutate: deleteMutateMock, isPending: false }) },
      setStatus: {
        useMutation: () => ({ mutate: setStatusMutateMock, isPending: false }),
      },
    },
  },
}));

import { ScoutsPage } from "./ScoutsPage";

const NOW = new Date();

function makeScout(overrides: Record<string, unknown> = {}) {
  return {
    id: "scout-" + (overrides.name ?? "x"),
    name: "A scout",
    location: "Snowdonia, Gwynedd",
    outcodes: ["LL55", "LL48"],
    types: ["Detached", "Cottage"],
    condition: ["Some updating"],
    land: [],
    saleMethods: ["Private treaty"],
    minBedrooms: 3,
    maxPricePence: 65_000_000, // £650,000
    keywords: "A stone house with mountain views.",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const SCOUTS = [
  makeScout({
    id: "scout-snowdonia",
    name: "Snowdonia — detached with a view",
    outcodes: ["LL55", "LL48", "LL40"],
    types: ["Detached", "Cottage"],
    condition: ["Some updating", "Full renovation"],
    saleMethods: ["Private treaty", "Auction"],
    status: "active",
  }),
  makeScout({
    id: "scout-bermondsey",
    name: "Bermondsey family home",
    location: "Bermondsey — SE16",
    outcodes: ["SE16", "SE1"],
    types: ["Terraced"],
    condition: ["Move-in ready"],
    saleMethods: ["Private treaty"],
    minBedrooms: 3,
    maxPricePence: 70_000_000,
    status: "paused",
  }),
];

function withScouts(scouts: unknown[] = SCOUTS) {
  listQueryMock.mockReturnValue({
    data: scouts,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
}

beforeEach(() => {
  invalidateMock.mockClear();
  createMutateMock.mockClear();
  updateMutateMock.mockClear();
  deleteMutateMock.mockClear();
  setStatusMutateMock.mockClear();
});

describe("ScoutsPage states", () => {
  it("shows a loading message while the query is pending", () => {
    listQueryMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    });
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    expect(screen.getByText(/loading scouts/i)).toBeInTheDocument();
    expect(screen.queryByTestId("scout-card")).not.toBeInTheDocument();
  });

  it("shows an error + Retry that calls refetch", () => {
    const refetch = vi.fn();
    listQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn.t load your scouts/i);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state when there are no scouts", () => {
    withScouts([]);
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    expect(screen.getByTestId("scouts-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("scout-card")).not.toBeInTheDocument();
  });
});

describe("ScoutsPage cards", () => {
  it("renders one card per scout with name, chips, and active count", () => {
    withScouts();
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    const cards = screen.getAllByTestId("scout-card");
    expect(cards).toHaveLength(2);
    expect(screen.getByText("Snowdonia — detached with a view")).toBeInTheDocument();
    expect(screen.getByText("Bermondsey family home")).toBeInTheDocument();
    // 2 scouts · 1 active (Bermondsey is paused).
    const count = screen.getByTestId("scouts-count");
    expect(count).toHaveTextContent("2");
    expect(count).toHaveTextContent("1");
    expect(count).toHaveTextContent("active");
  });

  it("shows a gold Auction tag only when saleMethods includes Auction", () => {
    withScouts();
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    // Only the Snowdonia scout includes Auction.
    expect(screen.getAllByTestId("scout-auction-tag")).toHaveLength(1);
  });

  it("links through to the scout's homes with its outcodes + status", () => {
    const onViewHomes = vi.fn();
    withScouts();
    render(<ScoutsPage onViewHomes={onViewHomes} />);
    const snowdonia = screen.getByText("Snowdonia — detached with a view").closest(
      "[data-testid='scout-card']",
    ) as HTMLElement;
    fireEvent.click(within(snowdonia).getByTestId("scout-homes-link"));
    expect(onViewHomes).toHaveBeenCalledTimes(1);
    expect(onViewHomes).toHaveBeenCalledWith({
      name: "Snowdonia — detached with a view",
      outcodes: ["LL55", "LL48", "LL40"],
      status: "active",
    });
  });
});

describe("ScoutsPage status toggle", () => {
  it("resumes a paused scout instantly (no confirm)", () => {
    withScouts();
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    const bermondsey = screen.getByText("Bermondsey family home").closest(
      "[data-testid='scout-card']",
    ) as HTMLElement;
    fireEvent.click(within(bermondsey).getByTestId("scout-status-pill"));
    expect(screen.queryByTestId("scout-pause-confirm")).not.toBeInTheDocument();
    expect(setStatusMutateMock).toHaveBeenCalledWith({
      id: "scout-bermondsey",
      status: "active",
    });
  });

  it("asks before pausing an active scout, then pauses on confirm", () => {
    withScouts();
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    const snowdonia = screen.getByText("Snowdonia — detached with a view").closest(
      "[data-testid='scout-card']",
    ) as HTMLElement;
    fireEvent.click(within(snowdonia).getByTestId("scout-status-pill"));
    // Confirm modal appears; nothing has been mutated yet.
    expect(screen.getByTestId("scout-pause-confirm")).toBeInTheDocument();
    expect(setStatusMutateMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("scout-pause-confirm-btn"));
    expect(setStatusMutateMock).toHaveBeenCalledWith({
      id: "scout-snowdonia",
      status: "paused",
    });
  });

  it("cancels the pause confirm without mutating", () => {
    withScouts();
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    const snowdonia = screen.getByText("Snowdonia — detached with a view").closest(
      "[data-testid='scout-card']",
    ) as HTMLElement;
    fireEvent.click(within(snowdonia).getByTestId("scout-status-pill"));
    fireEvent.click(screen.getByRole("button", { name: /keep active/i }));
    expect(screen.queryByTestId("scout-pause-confirm")).not.toBeInTheDocument();
    expect(setStatusMutateMock).not.toHaveBeenCalled();
  });
});

describe("ScoutsPage editor", () => {
  it("opens a blank editor from New scout and creates with pence + nulls", () => {
    withScouts();
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    fireEvent.click(screen.getByTestId("new-scout"));
    const editor = screen.getByTestId("scout-editor");
    expect(editor).toBeInTheDocument();

    fireEvent.change(within(editor).getByTestId("scout-name"), {
      target: { value: "Coastal cottage" },
    });
    fireEvent.change(within(editor).getByTestId("scout-location"), {
      target: { value: "Pembrokeshire" },
    });
    fireEvent.change(within(editor).getByTestId("scout-max-price"), {
      target: { value: "500000" },
    });
    fireEvent.click(within(editor).getByTestId("scout-save"));

    expect(createMutateMock).toHaveBeenCalledTimes(1);
    const payload = createMutateMock.mock.calls[0]![0];
    expect(payload).toMatchObject({
      name: "Coastal cottage",
      location: "Pembrokeshire",
      maxPricePence: 50_000_000, // £500,000 → pence
      minBedrooms: null, // left blank
    });
  });

  it("toggles a chip-select option on and off", () => {
    withScouts();
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    fireEvent.click(screen.getByTestId("new-scout"));
    const editor = screen.getByTestId("scout-editor");
    const farmhouse = within(editor).getByRole("button", { name: /farmhouse/i });
    expect(farmhouse).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(farmhouse);
    expect(farmhouse).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(farmhouse);
    expect(farmhouse).toHaveAttribute("aria-pressed", "false");
  });

  it("interpolates the live email preview from the form", () => {
    withScouts();
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    fireEvent.click(screen.getByTestId("new-scout"));
    const editor = screen.getByTestId("scout-editor");

    fireEvent.change(within(editor).getByTestId("scout-location"), {
      target: { value: "Hampstead, NW3" },
    });
    fireEvent.change(within(editor).getByTestId("scout-min-beds"), {
      target: { value: "2" },
    });
    // Pick Auction so its line appears in the body.
    fireEvent.click(within(editor).getByRole("button", { name: /auction/i }));
    fireEvent.click(within(editor).getByTestId("scout-preview-toggle"));

    const preview = within(editor).getByTestId("scout-email-preview");
    expect(preview).toHaveTextContent("Hampstead, NW3");
    expect(preview).toHaveTextContent("2+ bedroom");
    expect(preview).toHaveTextContent(/auction lots/i);
  });

  it("opens an existing scout pre-filled and updates with its id", () => {
    withScouts();
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    const snowdonia = screen.getByText("Snowdonia — detached with a view").closest(
      "[data-testid='scout-card']",
    ) as HTMLElement;
    fireEvent.click(snowdonia);
    const editor = screen.getByTestId("scout-editor");
    expect(within(editor).getByTestId("scout-name")).toHaveValue(
      "Snowdonia — detached with a view",
    );
    fireEvent.click(within(editor).getByTestId("scout-save"));
    expect(updateMutateMock).toHaveBeenCalledTimes(1);
    expect(updateMutateMock.mock.calls[0]![0]).toMatchObject({ id: "scout-snowdonia" });
  });

  it("deletes an existing scout from the editor", () => {
    withScouts();
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    const snowdonia = screen.getByText("Snowdonia — detached with a view").closest(
      "[data-testid='scout-card']",
    ) as HTMLElement;
    fireEvent.click(snowdonia);
    fireEvent.click(screen.getByTestId("scout-delete"));
    expect(deleteMutateMock).toHaveBeenCalledWith({ id: "scout-snowdonia" });
  });
});
