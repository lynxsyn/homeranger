/**
 * AuthProvider unit tests — the SPA's sign-in status gate. The supabase client
 * is mocked at the module boundary (AUTH_BYPASS off so the real session path
 * runs); getSession + onAuthStateChange drive the status, and signOut delegates
 * to supabase.auth.signOut.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { getSessionMock, onAuthStateChangeMock, signOutMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  onAuthStateChangeMock: vi.fn(() => ({
    data: { subscription: { unsubscribe: vi.fn() } },
  })),
  signOutMock: vi.fn(() => Promise.resolve({ error: null })),
}));

vi.mock("./supabase", () => ({
  AUTH_BYPASS: false,
  supabase: {
    auth: {
      getSession: getSessionMock,
      onAuthStateChange: onAuthStateChangeMock,
      signOut: signOutMock,
    },
  },
}));

import { AuthProvider, useAuth } from "./auth";

function Probe() {
  const { status, user, signOut } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="email">{user?.email ?? "—"}</span>
      <button type="button" data-testid="out" onClick={() => void signOut()}>
        out
      </button>
    </div>
  );
}

afterEach(() => {
  getSessionMock.mockReset();
  signOutMock.mockClear();
});

describe("AuthProvider", () => {
  it("maps a Supabase session to an authenticated identity", async () => {
    getSessionMock.mockResolvedValue({
      data: {
        session: { user: { id: "u-1", email: "person@homeranger.test" } },
      },
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated"),
    );
    expect(screen.getByTestId("email")).toHaveTextContent("person@homeranger.test");
  });

  it("reports anonymous when there is no session", async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("anonymous"),
    );
  });

  it("signOut delegates to supabase and flips to anonymous", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { user: { id: "u-1", email: "p@homeranger.test" } } },
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated"),
    );
    fireEvent.click(screen.getByTestId("out"));
    expect(signOutMock).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("anonymous"),
    );
  });
});
