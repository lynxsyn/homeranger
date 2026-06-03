/**
 * UserMenu unit tests — the account avatar + dropdown. A mocked `preferences.get`
 * feeds the avatar initials + header; react-router's MemoryRouter supplies the
 * active route. Primary nav now lives in the topbar tabs, so the dropdown carries
 * only Settings + Theme + Sign out. Asserts: avatar glyph vs initials, the menu
 * opens with Settings + Theme (and no Listings/Searches), the active route is
 * marked, navigation delegates to `onNavigate`, and the theme row toggles.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const { profileQueryMock } = vi.hoisted(() => ({ profileQueryMock: vi.fn() }));

vi.mock("../lib/trpc", () => ({
  trpc: { preferences: { get: { useQuery: profileQueryMock } } },
}));

// The menu reads the signed-in email from useAuth; mock it (no AuthProvider).
vi.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", email: "user@homeranger.test" } }),
}));

import { UserMenu } from "./UserMenu";

function withProfile(overrides: Record<string, unknown> = {}) {
  profileQueryMock.mockReturnValue({
    data: { firstName: "", lastName: "", phone: "", urgency: "active", ...overrides },
  });
}

function renderMenu(
  props: Partial<React.ComponentProps<typeof UserMenu>> = {},
  path = "/listings",
) {
  const onNavigate = props.onNavigate ?? vi.fn();
  const onToggleTheme = props.onToggleTheme ?? vi.fn();
  const onSignOut = props.onSignOut ?? vi.fn();
  render(
    <MemoryRouter initialEntries={[path]}>
      <UserMenu
        theme={props.theme ?? "light"}
        onNavigate={onNavigate}
        onToggleTheme={onToggleTheme}
        onSignOut={onSignOut}
      />
    </MemoryRouter>,
  );
  return { onNavigate, onToggleTheme, onSignOut };
}

beforeEach(() => {
  profileQueryMock.mockReset();
  withProfile();
});

describe("UserMenu avatar", () => {
  it("shows a user glyph (no initials) for a blank profile", () => {
    renderMenu();
    const avatar = screen.getByTestId("account-avatar");
    expect(avatar).toHaveTextContent("");
    expect(avatar.querySelector("svg")).toBeInTheDocument();
  });

  it("shows initials once the name is filled in", () => {
    withProfile({ firstName: "Jane", lastName: "Whitfield" });
    renderMenu();
    expect(screen.getByTestId("account-avatar")).toHaveTextContent("JW");
  });
});

describe("UserMenu dropdown", () => {
  it("is closed until the avatar is clicked, then lists Settings + theme only", () => {
    renderMenu();
    expect(screen.queryByTestId("account-menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("account-avatar"));
    const menu = screen.getByTestId("account-menu");
    expect(within(menu).getByTestId("nav-settings")).toHaveTextContent("Settings");
    expect(within(menu).getByTestId("theme-toggle")).toHaveTextContent("Theme");
    // Listings/Searches are topbar tabs now, not dropdown items.
    expect(within(menu).queryByTestId("nav-listings")).not.toBeInTheDocument();
    expect(within(menu).queryByTestId("nav-searches")).not.toBeInTheDocument();
  });

  it("marks Settings active when on /settings", () => {
    renderMenu({}, "/settings");
    fireEvent.click(screen.getByTestId("account-avatar"));
    expect(screen.getByTestId("nav-settings")).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("delegates navigation to onNavigate with the route, then closes", () => {
    const { onNavigate } = renderMenu();
    fireEvent.click(screen.getByTestId("account-avatar"));
    fireEvent.click(screen.getByTestId("nav-settings"));
    expect(onNavigate).toHaveBeenCalledWith("/settings");
    expect(screen.queryByTestId("account-menu")).not.toBeInTheDocument();
  });

  it("shows the name + urgency in the header once filled in", () => {
    withProfile({ firstName: "Jane", lastName: "Whitfield", urgency: "ready" });
    renderMenu();
    fireEvent.click(screen.getByTestId("account-avatar"));
    const menu = screen.getByTestId("account-menu");
    expect(menu).toHaveTextContent("Jane Whitfield");
    expect(menu).toHaveTextContent("Ready to move");
  });
});

describe("UserMenu theme row", () => {
  it("reports the current theme and toggles it", () => {
    const { onToggleTheme } = renderMenu({ theme: "dark" });
    fireEvent.click(screen.getByTestId("account-avatar"));
    expect(screen.getByTestId("theme-state")).toHaveTextContent("Dark");
    fireEvent.click(screen.getByTestId("theme-toggle"));
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
  });
});

describe("UserMenu account identity + sign out", () => {
  it("shows the signed-in email in the header", () => {
    renderMenu();
    fireEvent.click(screen.getByTestId("account-avatar"));
    expect(screen.getByTestId("account-email")).toHaveTextContent(
      "user@homeranger.test",
    );
  });

  it("delegates Sign out to onSignOut and closes the menu", () => {
    const { onSignOut } = renderMenu();
    fireEvent.click(screen.getByTestId("account-avatar"));
    fireEvent.click(screen.getByTestId("sign-out"));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("account-menu")).not.toBeInTheDocument();
  });
});
