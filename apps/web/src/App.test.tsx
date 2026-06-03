/**
 * App shell gate tests — the three-way auth switch (loading → spinner,
 * anonymous → SignInPage, authenticated → the routed app) plus the new editorial
 * topbar: the nav tabs (Listings / Searches / Agents), the primary "New search"
 * CTA, and the operator gating of the Agents tab. useAuth + tRPC are mocked and
 * the heavy pages/UserMenu are stubbed so the gate renders without real data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const { useAuthMock, meQueryMock } = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
  meQueryMock: vi.fn(),
}));
vi.mock("./lib/auth", () => ({ useAuth: useAuthMock }));
vi.mock("./lib/trpc", () => ({
  trpc: { auth: { me: { useQuery: meQueryMock } } },
}));
vi.mock("./pages/ListingsPage", () => ({
  ListingsPage: () => <div data-testid="stub-listings" />,
}));
vi.mock("./pages/SearchesPage", () => ({
  SearchesPage: () => <div data-testid="stub-searches" />,
}));
vi.mock("./pages/AgentsPage", () => ({
  AgentsPage: () => <div data-testid="stub-agents" />,
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

function renderApp(path = "/listings") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

function authed() {
  useAuthMock.mockReturnValue({
    status: "authenticated",
    user: { id: "u1", email: "u@homeranger.test" },
    signOut: vi.fn(),
  });
}

beforeEach(() => {
  // Default to the operator so the Agents tab renders; individual tests override.
  meQueryMock.mockReturnValue({
    data: { id: "u1", email: "dev@homeranger.local", isOperator: true },
  });
});

afterEach(() => {
  useAuthMock.mockReset();
  meQueryMock.mockReset();
});

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
    authed();
    renderApp();
    expect(screen.getByTestId("brand-home")).toBeInTheDocument();
    expect(screen.getByTestId("stub-usermenu")).toBeInTheDocument();
    expect(screen.getByTestId("stub-listings")).toBeInTheDocument();
    expect(screen.queryByTestId("auth-page")).not.toBeInTheDocument();
  });
});

describe("App topbar nav", () => {
  it("renders the Listings + Searches tabs and the New search CTA", () => {
    authed();
    renderApp();
    expect(screen.getByTestId("nav-listings")).toHaveTextContent("Listings");
    expect(screen.getByTestId("nav-searches")).toHaveTextContent("Searches");
    expect(screen.getByTestId("new-search")).toHaveTextContent(/new search/i);
  });

  it("marks the active tab via aria-current derived from the route", () => {
    authed();
    renderApp("/searches");
    expect(screen.getByTestId("nav-searches")).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByTestId("nav-listings")).not.toHaveAttribute("aria-current");
  });

  it("navigates to a tab's route on click", () => {
    authed();
    renderApp("/listings");
    fireEvent.click(screen.getByTestId("nav-searches"));
    expect(screen.getByTestId("stub-searches")).toBeInTheDocument();
  });

  it("shows the Agents tab for an operator and routes to it", () => {
    authed();
    renderApp("/listings");
    const agentsTab = screen.getByTestId("nav-agents");
    expect(agentsTab).toHaveTextContent("Agents");
    fireEvent.click(agentsTab);
    expect(screen.getByTestId("stub-agents")).toBeInTheDocument();
  });

  it("hides the Agents tab for a non-operator", () => {
    authed();
    meQueryMock.mockReturnValue({
      data: { id: "p1", email: "partner@homeranger.test", isOperator: false },
    });
    renderApp("/listings");
    expect(screen.queryByTestId("nav-agents")).not.toBeInTheDocument();
    // Listings + Searches tabs still render for non-operators.
    expect(screen.getByTestId("nav-listings")).toBeInTheDocument();
    expect(screen.getByTestId("nav-searches")).toBeInTheDocument();
  });

  it("routes to /settings via the avatar dropdown is no longer in the topbar tabs", () => {
    authed();
    renderApp();
    // Settings is not a topbar tab — it lives in the UserMenu dropdown.
    expect(screen.queryByTestId("nav-settings")).not.toBeInTheDocument();
  });
});
