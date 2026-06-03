/**
 * App shell — the HomeRanger topbar (clickable logo + the account avatar) over
 * the routed content, all inside the `.app` max-width container.
 *
 * Navigation + the theme toggle live in the avatar dropdown (UserMenu): the bar
 * is just the logo and the avatar. `/listings` is the listings table; `/scouts`
 * is the saved-search manager (labelled "Searches" in the menu — the route stays
 * internal); `/settings` is the operator's "Your details"; `/` redirects to
 * listings. A search's "View homes" link sets `scoutFilter` and navigates to
 * `/listings`; any menu navigation (or the logo) clears the filter so manual
 * navigation always shows the full list.
 *
 * The theme (`light`/`dark`) persists to `localStorage` under `hs-theme` and is
 * applied to `<html data-theme>` — the same key the pre-paint script in
 * index.html reads to avoid a flash.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { ListingsPage } from "./pages/ListingsPage";
import { ScoutsPage } from "./pages/ScoutsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SignInPage } from "./pages/SignInPage";
import type { ScoutFilter } from "./pages/ScoutsPage";
import { Logo } from "./components/ui";
import { UserMenu } from "./components/UserMenu";
import { useStored } from "./lib/useStored";
import { useAuth } from "./lib/auth";

export function App() {
  const { status } = useAuth();

  // Gate the whole app on the Supabase sign-in status: a brief loading state
  // while the session resolves, then the sign-in page until authenticated.
  if (status === "loading") {
    return (
      <div className="app auth-loading" data-testid="auth-loading" aria-busy="true">
        <Logo size={30} />
      </div>
    );
  }
  if (status === "anonymous") {
    return <SignInPage />;
  }
  return <AuthedApp />;
}

function AuthedApp() {
  const { signOut } = useAuth();
  // A search's "View homes" pushes its outcodes into the Listings view; any menu
  // navigation (or clicking the logo) clears it.
  const [scoutFilter, setScoutFilter] = useState<ScoutFilter | null>(null);
  const [theme, setTheme] = useStored<"light" | "dark">("hs-theme", "light", [
    "light",
    "dark",
  ]);
  const navigate = useNavigate();

  // Reflect the theme onto <html data-theme> (index.html applies the stored
  // value pre-paint; this keeps it in sync on every toggle).
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Menu navigation always shows the full set: clear any active scout filter,
  // then route.
  function goTo(to: string) {
    setScoutFilter(null);
    navigate(to);
  }

  function viewScoutHomes(filter: ScoutFilter) {
    setScoutFilter(filter);
    navigate("/listings");
  }

  return (
    <div className="app">
      <header className="topbar">
        <button
          type="button"
          className="brand-btn"
          data-testid="brand-home"
          aria-label="HomeRanger — listings"
          onClick={() => goTo("/listings")}
        >
          <Logo size={30} />
        </button>
        <div className="topbar__right">
          <UserMenu
            theme={theme}
            onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
            onNavigate={goTo}
            onSignOut={() => void signOut()}
          />
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
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </div>
  );
}
