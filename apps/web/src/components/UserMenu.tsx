/**
 * UserMenu — the top-right account avatar + dropdown that consolidates the app's
 * navigation and theme toggle (a faithful port of the claude.ai/design handoff,
 * project/app/settings.jsx). The top bar is now just the logo + this avatar;
 * clicking the avatar opens a tidy menu: Listings, Searches, Settings, and a
 * Theme row with the sun/moon toggle.
 *
 * The avatar shows the buyer's initials once their details are filled in (a user
 * glyph until then), read from the single SearchProfile via `preferences.get`.
 * The menu header shows their name + current urgency. Navigation is delegated to
 * `onNavigate` (the App clears any scout filter, then routes) so manual nav
 * always lands on the full set; active item is derived from the current route.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { OUTREACH_URGENCY_LEVELS, buyerFullName } from "@homeranger/shared";
import { trpc } from "../lib/trpc";
import { useAuth } from "../lib/auth";
import { Icon } from "./Icon";

/** The user-facing nav. Routes stay internal (`/scouts`), labels are the brand
 *  copy ("Searches"). Order matches the design's dropdown. */
const NAV = [
  { label: "Listings", icon: "home", to: "/listings", testid: "nav-listings" },
  { label: "Searches", icon: "search", to: "/scouts", testid: "nav-scouts" },
  { label: "Settings", icon: "settings", to: "/settings", testid: "nav-settings" },
] as const;

export interface UserMenuProps {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  /** App-level navigation: clears any scout filter, then routes to `to`. */
  onNavigate: (to: string) => void;
  /** Sign the user out of Supabase (returns to the sign-in gate). */
  onSignOut: () => void;
}

function initialsOf(firstName: string, lastName: string): string {
  return [firstName, lastName]
    .map((s) => s.trim()[0])
    .filter(Boolean)
    .join("")
    .toUpperCase();
}

export function UserMenu({
  theme,
  onToggleTheme,
  onNavigate,
  onSignOut,
}: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const { data: profile } = trpc.preferences.get.useQuery();
  const { user } = useAuth();

  const firstName = profile?.firstName ?? "";
  const lastName = profile?.lastName ?? "";
  const initials = initialsOf(firstName, lastName);
  const name = buyerFullName({ firstName, lastName });
  const email = user?.email ?? "";
  const urgency = OUTREACH_URGENCY_LEVELS.find((u) => u.id === profile?.urgency);
  const isDark = theme === "dark";
  // The avatar reads "active" when the menu is open or we're on Settings (its
  // home), mirroring the design's avatar ring.
  const onSettings = pathname === "/settings";

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function go(to: string) {
    onNavigate(to);
    setOpen(false);
  }

  return (
    <div className="usermenu" ref={wrapRef}>
      <button
        type="button"
        className="avatar-btn"
        data-testid="account-avatar"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={open || onSettings}
        aria-label="Your account"
        title="Your account"
        onClick={() => setOpen((o) => !o)}
      >
        {initials || <Icon name="user" size={18} />}
      </button>

      {open && (
        <div
          className="usermenu__pop"
          role="menu"
          aria-label="Account"
          data-testid="account-menu"
        >
          <div className="um-head">
            <span className="um-name">{name || "Your account"}</span>
            {email && (
              <span className="um-email" data-testid="account-email">
                {email}
              </span>
            )}
            <span className="um-sub">
              {name
                ? urgency
                  ? urgency.label
                  : "Set up your details"
                : "Add your name & phone"}
            </span>
          </div>
          <div className="um-group">
            {NAV.map((n) => {
              const active = pathname === n.to;
              return (
                <button
                  key={n.to}
                  type="button"
                  role="menuitem"
                  data-testid={n.testid}
                  className={`um-item${active ? " is-active" : ""}`}
                  aria-current={active}
                  onClick={() => go(n.to)}
                >
                  <Icon name={n.icon} size={17} />
                  <span>{n.label}</span>
                  {active && <Icon name="check" size={15} className="um-check" />}
                </button>
              );
            })}
          </div>
          <div className="um-divider" />
          <button
            type="button"
            role="menuitem"
            className="um-item um-theme"
            data-testid="theme-toggle"
            aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
            onClick={onToggleTheme}
          >
            <Icon name={isDark ? "sun" : "moon"} size={17} />
            <span>Theme</span>
            <span className="um-theme-state" data-testid="theme-state">
              {isDark ? "Dark" : "Light"}
            </span>
          </button>
          <div className="um-divider" />
          <button
            type="button"
            role="menuitem"
            className="um-item um-signout"
            data-testid="sign-out"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            <Icon name="log-out" size={17} />
            <span>Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
}
