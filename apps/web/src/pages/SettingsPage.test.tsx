/**
 * SettingsPage unit tests — render the "Your details" screen with a mocked tRPC
 * client and assert: the form seeds from `preferences.get`, Save is gated on a
 * dirty edit and forwards the identity to `preferences.update`, urgency is a
 * single-select, and the "How this reads to agents" preview reflects the
 * sign-off (name + phone, RESEND_FROM fallback) + the urgency line live.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const {
  profileQueryMock,
  updateMutateMock,
  invalidateMock,
  meQueryMock,
  killSwitchGetMock,
  killSwitchToggleMock,
  killSwitchInvalidateMock,
  warmupQueryMock,
} = vi.hoisted(() => ({
  profileQueryMock: vi.fn(),
  updateMutateMock: vi.fn(),
  invalidateMock: vi.fn(),
  meQueryMock: vi.fn(),
  killSwitchGetMock: vi.fn(),
  killSwitchToggleMock: vi.fn(),
  killSwitchInvalidateMock: vi.fn(),
  warmupQueryMock: vi.fn(),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      preferences: { get: { invalidate: invalidateMock } },
      outreach: { killSwitch: { get: { invalidate: killSwitchInvalidateMock } } },
    }),
    auth: { me: { useQuery: meQueryMock } },
    preferences: {
      get: { useQuery: profileQueryMock },
      update: {
        useMutation: (opts?: { onSuccess?: () => void }) => ({
          mutate: (input: Record<string, unknown>) => {
            updateMutateMock(input);
            // Simulate the server + the onSuccess invalidate→refetch: a later
            // read of preferences.get returns the just-saved profile, so the
            // form is no longer dirty and the "Saved" note can show.
            profileQueryMock.mockReturnValue({
              data: {
                firstName: "",
                lastName: "",
                phone: "",
                urgency: "active",
                ...input,
              },
            });
            opts?.onSuccess?.();
          },
          isPending: false,
        }),
      },
    },
    outreach: {
      senderName: { useQuery: () => ({ data: { name: "Bryan" } }) },
      warmup: { useQuery: warmupQueryMock },
      killSwitch: {
        get: { useQuery: killSwitchGetMock },
        toggle: {
          useMutation: (opts?: { onSuccess?: () => void }) => ({
            mutate: (input: unknown) => {
              killSwitchToggleMock(input);
              opts?.onSuccess?.();
            },
            isPending: false,
          }),
        },
      },
    },
  },
}));

import { SettingsPage } from "./SettingsPage";

function withProfile(overrides: Record<string, unknown> = {}) {
  profileQueryMock.mockReturnValue({
    data: {
      firstName: "",
      lastName: "",
      phone: "",
      urgency: "active",
      ...overrides,
    },
  });
}

beforeEach(() => {
  updateMutateMock.mockClear();
  invalidateMock.mockClear();
  killSwitchToggleMock.mockClear();
  killSwitchInvalidateMock.mockClear();
  withProfile();
  // Default to a NON-operator so the profile-form tests do not render the
  // operator-only Outreach control; the operator case is exercised explicitly.
  meQueryMock.mockReturnValue({
    data: { id: "u1", email: "user@homeranger.test", isOperator: false },
  });
  killSwitchGetMock.mockReturnValue({ data: { enabled: false } });
  warmupQueryMock.mockReturnValue({ data: { sentToday: 6, dailyCap: 20 } });
});

describe("SettingsPage", () => {
  it("seeds the form from the saved profile", async () => {
    withProfile({ firstName: "Jane", lastName: "Whitfield", phone: "07700 900123" });
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("settings-first-name")).toHaveValue("Jane"),
    );
    expect(screen.getByTestId("settings-last-name")).toHaveValue("Whitfield");
    expect(screen.getByTestId("settings-phone")).toHaveValue("07700 900123");
  });

  it("gates Save on a dirty edit and forwards the identity to update", async () => {
    render(<SettingsPage />);
    const save = screen.getByTestId("settings-save");
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByTestId("settings-first-name"), {
      target: { value: "Jane" },
    });
    fireEvent.change(screen.getByTestId("settings-phone"), {
      target: { value: "07700 900123" },
    });
    fireEvent.click(screen.getByTestId("urgency-ready"));
    expect(save).not.toBeDisabled();

    fireEvent.click(save);
    expect(updateMutateMock).toHaveBeenCalledWith({
      firstName: "Jane",
      lastName: "",
      phone: "07700 900123",
      urgency: "ready",
    });
    await waitFor(() =>
      expect(screen.getByTestId("settings-saved")).toBeInTheDocument(),
    );
  });

  it("previews the sign-off (name + phone) and urgency line live", async () => {
    render(<SettingsPage />);
    fireEvent.change(screen.getByTestId("settings-first-name"), {
      target: { value: "Jane" },
    });
    fireEvent.change(screen.getByTestId("settings-last-name"), {
      target: { value: "Whitfield" },
    });
    fireEvent.change(screen.getByTestId("settings-phone"), {
      target: { value: "07700 900123" },
    });
    fireEvent.click(screen.getByTestId("urgency-ready"));

    expect(screen.getByTestId("settings-signature")).toHaveTextContent(
      "Many thanks, Jane Whitfield 07700 900123",
    );
    expect(screen.getByTestId("settings-urgency-line")).toHaveTextContent(
      "I'm in a strong position to proceed",
    );
  });

  it("falls back to the RESEND_FROM name in the sign-off when no name is set", () => {
    render(<SettingsPage />);
    expect(screen.getByTestId("settings-signature")).toHaveTextContent(
      "Many thanks, Bryan",
    );
  });

  it("shows the relaxed empty-urgency note for 'browsing'", () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("urgency-browsing"));
    expect(screen.queryByTestId("settings-urgency-line")).not.toBeInTheDocument();
    expect(
      screen.getByText(/your emails stay relaxed and open-ended/i),
    ).toBeInTheDocument();
  });

  it("makes urgency single-select (aria-pressed reflects the choice)", () => {
    render(<SettingsPage />);
    const ready = screen.getByTestId("urgency-ready");
    const soon = screen.getByTestId("urgency-soon");
    fireEvent.click(ready);
    expect(ready).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(soon);
    expect(soon).toHaveAttribute("aria-pressed", "true");
    expect(ready).toHaveAttribute("aria-pressed", "false");
  });

  it("hides the Outreach control for a non-operator", () => {
    // meQueryMock defaults to a non-operator in beforeEach.
    render(<SettingsPage />);
    expect(screen.queryByTestId("settings-outreach")).not.toBeInTheDocument();
    expect(screen.queryByTestId("kill-switch")).not.toBeInTheDocument();
  });

  it("shows the operator the Outreach kill-switch + warm-up meter, and toggles it", () => {
    meQueryMock.mockReturnValue({
      data: { id: "op", email: "dev@homeranger.local", isOperator: true },
    });
    render(<SettingsPage />);

    const outreach = screen.getByTestId("settings-outreach");
    expect(outreach).toBeInTheDocument();
    const sw = screen.getByTestId("kill-switch");
    // Live by default; the warm-up meter shows today / cap.
    expect(sw).toHaveAttribute("data-enabled", "false");
    expect(screen.getByTestId("kill-switch-state")).toHaveTextContent(/sending live/i);
    expect(outreach).toHaveTextContent("6 / 20");

    // Toggling flips the global kill-switch ON (paused) and refetches it.
    fireEvent.click(screen.getByRole("switch", { name: /pause all outreach/i }));
    expect(killSwitchToggleMock).toHaveBeenCalledWith({ enabled: true });
    expect(killSwitchInvalidateMock).toHaveBeenCalledTimes(1);
  });

  it("hides the warm-up meter when outreach is paused", () => {
    meQueryMock.mockReturnValue({
      data: { id: "op", email: "dev@homeranger.local", isOperator: true },
    });
    killSwitchGetMock.mockReturnValue({ data: { enabled: true } });
    render(<SettingsPage />);
    const sw = screen.getByTestId("kill-switch");
    expect(sw).toHaveAttribute("data-enabled", "true");
    expect(screen.getByTestId("kill-switch-state")).toHaveTextContent(/paused/i);
    // The warm-up meter only shows while sending is live.
    expect(screen.queryByText("6 / 20")).not.toBeInTheDocument();
  });
});
