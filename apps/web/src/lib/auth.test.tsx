/**
 * AuthProvider unit tests — the SPA's sign-in status gate. The supabase client
 * is mocked at the module boundary (AUTH_BYPASS off so the real session path
 * runs); getSession + onAuthStateChange drive the status, signOut delegates to
 * supabase.auth.signOut, and signUp forwards an emailRedirectTo back to the
 * current origin.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { getSessionMock, onAuthStateChangeMock, signOutMock, signUpMock } =
  vi.hoisted(() => ({
    getSessionMock: vi.fn(),
    onAuthStateChangeMock: vi.fn(() => ({
      data: { subscription: { unsubscribe: vi.fn() } },
    })),
    signOutMock: vi.fn(() => Promise.resolve({ error: null })),
    signUpMock: vi.fn(() =>
      Promise.resolve({
        data: { user: { id: "u-2" }, session: null },
        error: null,
      }),
    ),
  }));

vi.mock("./supabase", () => ({
  AUTH_BYPASS: false,
  supabase: {
    auth: {
      getSession: getSessionMock,
      onAuthStateChange: onAuthStateChangeMock,
      signOut: signOutMock,
      signUp: signUpMock,
    },
  },
}));

import { AuthProvider, useAuth } from "./auth";

function Probe() {
  const { status, user, signOut, signUp } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="email">{user?.email ?? "—"}</span>
      <button type="button" data-testid="out" onClick={() => void signOut()}>
        out
      </button>
      <button
        type="button"
        data-testid="signup"
        onClick={() => void signUp("new@homeranger.test", "pw-12345678")}
      >
        signup
      </button>
    </div>
  );
}

afterEach(() => {
  getSessionMock.mockReset();
  signOutMock.mockClear();
  signUpMock.mockClear();
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

  it("signUp asks Supabase to confirm back to the current origin", async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("anonymous"),
    );
    fireEvent.click(screen.getByTestId("signup"));
    await waitFor(() => expect(signUpMock).toHaveBeenCalledTimes(1));
    expect(signUpMock).toHaveBeenCalledWith({
      email: "new@homeranger.test",
      password: "pw-12345678",
      options: { emailRedirectTo: window.location.origin },
    });
  });
});
