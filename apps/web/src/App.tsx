/**
 * App shell — the HomeScout topbar (logo + primary nav + tagline + theme
 * toggle) over the routed content, all inside the `.app` max-width container.
 *
 * `/listings` is the listings table; `/preferences` is the search-profile
 * editor; `/` redirects to listings. The theme (`light`/`dark`) persists to
 * `localStorage` under `hs-theme` and is applied to `<html data-theme>` — the
 * same key the pre-paint script in index.html reads to avoid a flash.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { useEffect } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { ListingsPage } from "./pages/ListingsPage";
import { PreferencesPage } from "./pages/PreferencesPage";
import { Button, Logo } from "./components/ui";
import { useStored } from "./lib/useStored";

function ThemeToggle() {
  const [theme, setTheme] = useStored<"light" | "dark">("hs-theme", "light", [
    "light",
    "dark",
  ]);

  // Reflect the theme onto <html data-theme> (index.html applies the stored
  // value pre-paint; this keeps it in sync on every toggle).
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const isDark = theme === "dark";
  return (
    <Button
      variant="ghost"
      icon={isDark ? "sun" : "moon"}
      data-testid="theme-toggle"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    />
  );
}

export function App() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__left">
          <Logo size={30} />
          <nav className="app-nav" aria-label="Primary">
            <NavLink to="/listings" data-testid="nav-listings">
              Listings
            </NavLink>
            <NavLink to="/preferences" data-testid="nav-preferences">
              Preferences
            </NavLink>
          </nav>
        </div>
        <div className="topbar__right">
          <span className="tagline">Found before it&rsquo;s listed</span>
          <ThemeToggle />
        </div>
      </header>

      <Routes>
        <Route path="/" element={<Navigate to="/listings" replace />} />
        <Route path="/listings" element={<ListingsPage />} />
        <Route path="/preferences" element={<PreferencesPage />} />
      </Routes>
    </div>
  );
}
