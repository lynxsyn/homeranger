/**
 * App shell gate tests — the three-way auth switch (loading → spinner,
 * anonymous → SignInPage, authenticated → the routed app). useAuth is mocked and
 * the heavy pages/UserMenu are stubbed so the gate renders without tRPC/data.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const { useAuthMock } = vi.hoisted(() => ({ useAuthMock: vi.fn() }));
vi.mock("./lib/auth", () => ({ useAuth: useAuthMock }));
vi.mock("./pages/ListingsPage", () => ({
  ListingsPage: () => <div data-testid="stub-listings" />,
}));
vi.mock("./pages/ScoutsPage", () => ({
  ScoutsPage: () => <div data-testid="stub-scouts" />,
}));
vi.mock("./pages/SettingsPage", () => ({
  SettingsPage: () => <div data-testid="stub-settings" />,
}));
vi.mock("./pages/SignInPage", () => ({
  SignInPage: () => <div data-testid="auth-page" />,
}));
vi.mock("./components/UserMenu", () => ({
  UserMenu: () => <div data-testid="stub-usermenu" />,
}));

import { App } from "./App";

function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/listings"]}>
      <App />
    </MemoryRouter>,
  );
}

afterEach(() => useAuthMock.mockReset());

describe("App auth gate", () => {
  it("shows the loading splash while the session resolves", () => {
    useAuthMock.mockReturnValue({ status: "loading", user: null, signOut: vi.fn() });
    renderApp();
    expect(screen.getByTestId("auth-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("brand-home")).not.toBeInTheDocument();
    expect(screen.queryByTestId("auth-page")).not.toBeInTheDocument();
  });

  it("shows the sign-in page when anonymous (app hidden)", () => {
    useAuthMock.mockReturnValue({ status: "anonymous", user: null, signOut: vi.fn() });
    renderApp();
    expect(screen.getByTestId("auth-page")).toBeInTheDocument();
    expect(screen.queryByTestId("brand-home")).not.toBeInTheDocument();
  });

  it("mounts the routed app when authenticated", () => {
    useAuthMock.mockReturnValue({
      status: "authenticated",
      user: { id: "u1", email: "u@homeranger.test" },
      signOut: vi.fn(),
    });
    renderApp();
    expect(screen.getByTestId("brand-home")).toBeInTheDocument();
    expect(screen.getByTestId("stub-usermenu")).toBeInTheDocument();
    expect(screen.getByTestId("stub-listings")).toBeInTheDocument();
    expect(screen.queryByTestId("auth-page")).not.toBeInTheDocument();
  });
});
