/**
 * App shell — the HomeScout topbar (logo + primary nav + tagline + theme
 * toggle) over the routed content, all inside the `.app` max-width container.
 *
 * `/listings` is the listings table; `/scouts` is the saved-search scout
 * manager; `/` redirects to listings. A scout's "View homes" link sets
 * `scoutFilter` and navigates to `/listings`, which then fetches + banners the
 * scout's outcodes; clicking the Listings nav link clears the filter so manual
 * navigation always shows the full list.
 *
 * The theme (`light`/`dark`) persists to `localStorage` under `hs-theme` and is
 * applied to `<html data-theme>` — the same key the pre-paint script in
 * index.html reads to avoid a flash.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { ListingsPage } from "./pages/ListingsPage";
import { ScoutsPage } from "./pages/ScoutsPage";
import type { ScoutFilter } from "./pages/ScoutsPage";
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
  // A scout's "View homes" pushes its outcodes into the Listings view; manual
  // navigation to /listings clears it (see the Listings NavLink onClick).
  const [scoutFilter, setScoutFilter] = useState<ScoutFilter | null>(null);
  const navigate = useNavigate();

  function viewScoutHomes(filter: ScoutFilter) {
    setScoutFilter(filter);
    navigate("/listings");
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__left">
          <Logo size={30} />
          <nav className="app-nav" aria-label="Primary">
            <NavLink
              to="/listings"
              data-testid="nav-listings"
              onClick={() => setScoutFilter(null)}
            >
              Listings
            </NavLink>
            <NavLink to="/scouts" data-testid="nav-scouts">
              Scouts
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
        <Route
          path="/listings"
          element={
            <ListingsPage
              scoutFilter={scoutFilter}
              onClearScoutFilter={() => setScoutFilter(null)}
            />
          }
        />
        <Route
          path="/scouts"
          element={<ScoutsPage onViewHomes={viewScoutHomes} />}
        />
      </Routes>
    </div>
  );
}
