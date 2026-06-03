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
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const {
  listQueryMock,
  invalidateMock,
  killSwitchInvalidateMock,
  createMutateMock,
  updateMutateMock,
  deleteMutateMock,
  setStatusMutateMock,
  launchMutateMock,
  launchStateMock,
  reviewQueryMock,
  approveMutateMock,
  approveStateMock,
  statsQueryMock,
  killSwitchGetMock,
  killSwitchToggleMock,
  killSwitchToggleStateMock,
  locationsSuggestMock,
} = vi.hoisted(() => ({
  listQueryMock: vi.fn(),
  invalidateMock: vi.fn(),
  killSwitchInvalidateMock: vi.fn(),
  createMutateMock: vi.fn(),
  updateMutateMock: vi.fn(),
  deleteMutateMock: vi.fn(),
  setStatusMutateMock: vi.fn(),
  launchMutateMock: vi.fn(),
  // Mutable state the mocked launch mutation reports back to the component.
  launchStateMock: { isPending: false, isSuccess: true, isError: false, error: null },
  reviewQueryMock: vi.fn(),
  approveMutateMock: vi.fn(),
  approveStateMock: { isPending: false },
  statsQueryMock: vi.fn(),
  killSwitchGetMock: vi.fn(),
  killSwitchToggleMock: vi.fn(),
  killSwitchToggleStateMock: { isPending: false },
  locationsSuggestMock: vi.fn(),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      scouts: { list: { invalidate: invalidateMock } },
      outreach: { killSwitch: { get: { invalidate: killSwitchInvalidateMock } } },
    }),
    scouts: {
      list: { useQuery: listQueryMock },
      create: { useMutation: () => ({ mutate: createMutateMock, isPending: false }) },
      update: { useMutation: () => ({ mutate: updateMutateMock, isPending: false }) },
      delete: { useMutation: () => ({ mutate: deleteMutateMock, isPending: false }) },
      setStatus: {
        useMutation: () => ({ mutate: setStatusMutateMock, isPending: false }),
      },
      launch: {
        useMutation: () => ({
          mutate: launchMutateMock,
          ...launchStateMock,
        }),
      },
      reviewDrafts: { useQuery: reviewQueryMock },
      approveSends: {
        useMutation: (opts?: { onSuccess?: (res: unknown) => void }) => ({
          mutate: (input: unknown) => {
            approveMutateMock(input);
            // Echo the enqueued count back through onSuccess so the modal can
            // render its success state, matching the real router contract.
            const ids = (input as { agentIds: string[] }).agentIds;
            opts?.onSuccess?.({ enqueued: ids.length });
          },
          ...approveStateMock,
        }),
      },
      stats: { useQuery: statsQueryMock },
    },
    locations: {
      suggest: { useQuery: locationsSuggestMock },
    },
    outreach: {
      senderName: { useQuery: () => ({ data: { name: "Bryan" } }) },
      killSwitch: {
        get: { useQuery: killSwitchGetMock },
        toggle: {
          useMutation: (opts?: { onSuccess?: () => void }) => ({
            mutate: (input: unknown) => {
              killSwitchToggleMock(input);
              opts?.onSuccess?.();
            },
            ...killSwitchToggleStateMock,
          }),
        },
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

/** Default-eligible/ineligible agent pair for the launch checklist. */
const REVIEW_AGENTS = [
  {
    id: "agent-eligible",
    email: "sales@finch.co.uk",
    agencyName: "Finch & Co",
    eligible: true,
    reason: null,
  },
  {
    id: "agent-blocked",
    email: "opt@out.co.uk",
    agencyName: "Out Estates",
    eligible: false,
    reason: "AGENT_OPTED_OUT",
  },
];

const DEFAULT_REVIEW = {
  draft: "Hello,\n\nI'm a private buyer searching in Snowdonia.",
  agents: REVIEW_AGENTS,
};

function withReview(
  data: { draft: string; agents: typeof REVIEW_AGENTS } | null = DEFAULT_REVIEW,
  state: { isLoading?: boolean } = {},
) {
  reviewQueryMock.mockReturnValue({
    // `null` from a caller means "no data yet"; the component reads
    // `review.data` truthily, so coalesce to `undefined`.
    data: data ?? undefined,
    isLoading: state.isLoading ?? false,
  });
}

function withStats(
  stats = { homesFound: 12, agentsInPatch: 5, agentsContacted: 2 },
) {
  statsQueryMock.mockReturnValue({ data: stats, isLoading: false });
}

function withKillSwitch(enabled = false) {
  killSwitchGetMock.mockReturnValue({ data: { enabled } });
}

beforeEach(() => {
  invalidateMock.mockClear();
  killSwitchInvalidateMock.mockClear();
  createMutateMock.mockClear();
  updateMutateMock.mockClear();
  deleteMutateMock.mockClear();
  setStatusMutateMock.mockClear();
  launchMutateMock.mockClear();
  reviewQueryMock.mockClear();
  approveMutateMock.mockClear();
  statsQueryMock.mockClear();
  killSwitchGetMock.mockClear();
  killSwitchToggleMock.mockClear();
  locationsSuggestMock.mockClear();
  // Default: no location suggestions (the editor renders without a dropdown).
  locationsSuggestMock.mockReturnValue({ data: [] });
  launchStateMock.isPending = false;
  launchStateMock.isSuccess = true;
  launchStateMock.isError = false;
  launchStateMock.error = null;
  approveStateMock.isPending = false;
  killSwitchToggleStateMock.isPending = false;
  // Sensible defaults so existing tests that never touch the launch loop still
  // render: a resolved review, populated stats, and a live (off) kill-switch.
  withReview();
  withStats();
  withKillSwitch();
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
    // Signs off with the sender's name (from RESEND_FROM via outreach.senderName).
    expect(preview).toHaveTextContent(/Many thanks,\s*Bryan/);
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

  it("suggests UK locations as you type and fills the field on pick", () => {
    withScouts();
    locationsSuggestMock.mockReturnValue({
      data: [
        {
          label: "Conwy",
          kind: "district",
          outcodes: ["LL30", "LL31", "LL32"],
          hint: "District · 16 outcodes",
        },
        {
          label: "Llandudno",
          kind: "place",
          outcodes: ["LL30"],
          hint: "Town/area · 3 outcodes",
        },
      ],
    });
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    fireEvent.click(screen.getByTestId("new-scout"));
    const editor = screen.getByTestId("scout-editor");
    const input = within(editor).getByTestId("scout-location");

    // Typing opens the suggestion list (one row per suggestion, kind tagged).
    fireEvent.change(input, { target: { value: "Conw" } });
    const list = within(editor).getByTestId("scout-location-suggestions");
    const opts = within(list).getAllByTestId("scout-location-suggestion");
    expect(opts).toHaveLength(2);
    expect(opts[0]).toHaveTextContent("Conwy");
    expect(opts[0]).toHaveTextContent("16 outcodes");
    expect(opts[0]).toHaveAttribute("data-kind", "district");

    // ARIA combobox wiring: the input points at the listbox + the active option.
    expect(input).toHaveAttribute("aria-controls", list.id);
    expect(input).toHaveAttribute("aria-activedescendant", `${list.id}-opt-0`);
    const options = list.querySelectorAll('[role="option"]');
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("id", `${list.id}-opt-0`);

    // Picking a suggestion stores its canonical label + closes the list.
    fireEvent.mouseDown(opts[0]);
    expect(input).toHaveValue("Conwy");
    expect(
      within(editor).queryByTestId("scout-location-suggestions"),
    ).not.toBeInTheDocument();
  });
});

/** Open the launch modal for the named scout (clicks its card's Launch). */
function openLaunch(name = "Snowdonia — detached with a view") {
  const card = screen.getByText(name).closest(
    "[data-testid='scout-card']",
  ) as HTMLElement;
  fireEvent.click(within(card).getByTestId("scout-launch"));
}

describe("ScoutsPage per-scout stats", () => {
  it("renders homes-found and contacted/in-patch counts per card", () => {
    withScouts();
    withStats({ homesFound: 12, agentsInPatch: 5, agentsContacted: 2 });
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    // Both cards have outcodes → both show a stats strip.
    const strips = screen.getAllByTestId("scout-stats");
    expect(strips.length).toBe(2);
    expect(strips[0]).toHaveTextContent("12");
    expect(strips[0]).toHaveTextContent("2");
    expect(strips[0]).toHaveTextContent("5");
    // The stats query is keyed by scout id.
    expect(statsQueryMock).toHaveBeenCalledWith({ id: "scout-snowdonia" });
  });

  it("shows placeholders while stats are loading", () => {
    withScouts([SCOUTS[0]]);
    statsQueryMock.mockReturnValue({ data: undefined, isLoading: true });
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    expect(screen.getByTestId("scout-stats")).toHaveTextContent("–");
  });
});

describe("ScoutsPage launch loop", () => {
  it("launches on open and renders the woven draft + pre-checked agents", async () => {
    withScouts();
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    openLaunch();

    // The launch mutation fires once with the scout id.
    expect(launchMutateMock).toHaveBeenCalledWith({ id: "scout-snowdonia" });

    const modal = await screen.findByTestId("launch-modal");
    expect(within(modal).getByTestId("launch-draft")).toHaveTextContent(
      /private buyer searching in Snowdonia/i,
    );

    // One row per agent; the blocked one is disabled and shows its reason code.
    const rows = within(modal).getAllByTestId("launch-agent");
    expect(rows).toHaveLength(2);
    const eligibleRow = rows.find((r) => r.dataset.eligible === "true")!;
    const blockedRow = rows.find((r) => r.dataset.eligible === "false")!;
    expect(within(eligibleRow).getByRole("checkbox")).not.toBeDisabled();
    expect(within(blockedRow).getByRole("checkbox")).toBeDisabled();
    expect(blockedRow).toHaveTextContent("AGENT_OPTED_OUT");
  });

  it("pre-selects only eligible agents and approves the checked ids", async () => {
    withScouts();
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    openLaunch();

    const modal = await screen.findByTestId("launch-modal");
    // Eligible agent is pre-checked → approve button reflects 1.
    const approveBtn = within(modal).getByTestId("launch-approve");
    await waitFor(() => expect(approveBtn).toHaveTextContent("Approve & send 1"));

    fireEvent.click(approveBtn);
    expect(approveMutateMock).toHaveBeenCalledWith({
      id: "scout-snowdonia",
      agentIds: ["agent-eligible"], // the blocked agent is NOT enqueued
    });

    // Success state confirms the queued count.
    expect(within(modal).getByTestId("launch-sent")).toHaveTextContent(
      "1 agent queued",
    );
  });

  it("blocks approval when nothing eligible is checked", async () => {
    withScouts();
    // Only an ineligible agent in the patch → nothing gets pre-selected.
    withReview({
      draft: "Hello,",
      agents: [REVIEW_AGENTS[1]],
    });
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    openLaunch();

    const modal = await screen.findByTestId("launch-modal");
    const approveBtn = within(modal).getByTestId("launch-approve");
    expect(approveBtn).toBeDisabled();
    expect(approveBtn).toHaveTextContent("Approve & send 0");
  });

  it("shows a busy state while discovery is still running", () => {
    withScouts();
    // Launch hasn't resolved yet → review is gated off and we show the spinner.
    launchStateMock.isPending = true;
    launchStateMock.isSuccess = false;
    withReview(null, { isLoading: true });
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    openLaunch();
    expect(screen.getByTestId("launch-busy")).toBeInTheDocument();
    expect(screen.queryByTestId("launch-draft")).not.toBeInTheDocument();
  });
});

describe("ScoutsPage kill-switch", () => {
  it("reads the live (off) state and toggles it on", () => {
    withScouts();
    withKillSwitch(false);
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    const sw = screen.getByTestId("kill-switch");
    expect(screen.getByTestId("kill-switch-state")).toHaveTextContent(/sending live/i);
    fireEvent.click(within(sw).getByRole("switch"));
    expect(killSwitchToggleMock).toHaveBeenCalledWith({ enabled: true });
    // Refetches the kill-switch after a successful toggle.
    expect(killSwitchInvalidateMock).toHaveBeenCalledTimes(1);
  });

  it("reads the paused state and toggles it back off", () => {
    withScouts();
    withKillSwitch(true);
    render(<ScoutsPage onViewHomes={vi.fn()} />);
    const sw = screen.getByTestId("kill-switch");
    expect(screen.getByTestId("kill-switch-state")).toHaveTextContent(/sending paused/i);
    expect(within(sw).getByRole("switch")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(sw).getByRole("switch"));
    expect(killSwitchToggleMock).toHaveBeenCalledWith({ enabled: false });
  });
});
