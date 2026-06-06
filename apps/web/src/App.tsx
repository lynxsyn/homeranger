/**
 * App shell — the HomeRanger topbar (brand logo + editorial nav tabs + a primary
 * "New search" CTA + the account avatar) over the routed content, all inside the
 * `.app` max-width container.
 *
 * The nav tabs ARE the page titles: Listings (`/listings`), Searches
 * (`/searches`), and Agents (`/agents`, operator-only). The active tab is marked
 * via `aria-current="page"`, derived from the route. `/settings` is reached from
 * the avatar dropdown (UserMenu), which now carries only Settings + Theme + Sign
 * out. `/` redirects to listings.
 *
 * Two drill-in filters are lifted here so a tab click can clear them: a search's
 * "View homes" sets `searchFilter` and routes to `/listings`; its "View agents"
 * sets `agentFilter` and routes to `/agents`. `goTab` clears BOTH before
 * routing, so manual navigation always shows the full set. The "New search" CTA
 * routes to `/searches` and flips `pendingNew` so the page opens its editor.
 *
 * The theme (`light`/`dark`) persists to `localStorage` under `hs-theme` and is
 * applied to `<html data-theme>` — the same key the pre-paint script in
 * index.html reads to avoid a flash.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ListingsPage } from "./pages/ListingsPage";
import { SearchesPage } from "./pages/SearchesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AgentsPage } from "./pages/AgentsPage";
import { SourcesPage } from "./pages/SourcesPage";
import { SignInPage } from "./pages/SignInPage";
import type { SearchFilter } from "./pages/SearchesPage";
import type { AgentFilter } from "./pages/AgentsPage";
import type { SourceFilter } from "./pages/SourcesPage";
import { Button, Logo } from "./components/ui";
import { UserMenu } from "./components/UserMenu";
import { trpc } from "./lib/trpc";
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

/** The editorial top-nav tabs. Routes stay internal; the label IS the page
 *  title. Agents is operator-only (gated in the render). */
const TABS = [
  { label: "Listings", to: "/listings", testid: "nav-listings" },
  { label: "Searches", to: "/searches", testid: "nav-searches" },
  { label: "Agents", to: "/agents", testid: "nav-agents", operator: true },
  { label: "Sources", to: "/sources", testid: "nav-sources" },
] as const;

function AuthedApp() {
  const { signOut } = useAuth();
  // Two lifted drill-in filters: a search's "View homes" pushes its outcodes
  // into the Listings view; "View agents" pushes them into the Agents view. Any
  // tab navigation (or clicking the logo) clears BOTH.
  const [searchFilter, setSearchFilter] = useState<SearchFilter | null>(null);
  const [agentFilter, setAgentFilter] = useState<AgentFilter | null>(null);
  // A source's "View N lots" drill-in pushes the source's enum into the Listings
  // view (scoping Listing.primarySource) + shows a banner; cleared on any tab nav.
  const [sourceFilter, setSourceFilter] = useState<SourceFilter | null>(null);
  // The "New search" CTA lives in the topbar but the editor lives on the
  // Searches page; this flag carries the intent across the navigation.
  const [pendingNew, setPendingNew] = useState(false);
  const [theme, setTheme] = useStored<"light" | "dark">("hs-theme", "light", [
    "light",
    "dark",
  ]);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // The Agents tab + screen are operator-only (the discovered-agent pool +
  // outreach state is global, not per-user); the backend also enforces this.
  const { data: me } = trpc.auth.me.useQuery();
  const isOperator = me?.isOperator ?? false;

  // Reflect the theme onto <html data-theme> (index.html applies the stored
  // value pre-paint; this keeps it in sync on every toggle).
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Tab navigation always shows the full set: clear both drill-in filters, then
  // route. Used by the logo, the nav tabs, and the avatar menu.
  function goTab(to: string) {
    setSearchFilter(null);
    setAgentFilter(null);
    setSourceFilter(null);
    navigate(to);
  }

  function viewSearchHomes(filter: SearchFilter) {
    setSearchFilter(filter);
    navigate("/listings");
  }

  function viewAgents(filter: AgentFilter) {
    setAgentFilter(filter);
    navigate("/agents");
  }

  function viewSourceLots(filter: SourceFilter) {
    setSearchFilter(null);
    setAgentFilter(null);
    setSourceFilter(filter);
    navigate("/listings");
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__left">
          <button
            type="button"
            className="brand-btn"
            data-testid="brand-home"
            aria-label="HomeRanger — listings"
            onClick={() => goTab("/listings")}
          >
            <Logo size={28} />
          </button>
          <nav className="nav" aria-label="Primary">
            {TABS.filter((t) => !("operator" in t && t.operator) || isOperator).map(
              (t) => (
                <button
                  key={t.to}
                  type="button"
                  data-testid={t.testid}
                  aria-current={pathname === t.to ? "page" : undefined}
                  onClick={() => goTab(t.to)}
                >
                  {t.label}
                </button>
              ),
            )}
          </nav>
        </div>
        <div className="topbar__right">
          <Button
            variant="primary"
            size="sm"
            icon="search"
            data-testid="new-search"
            onClick={() => {
              goTab("/searches");
              setPendingNew(true);
            }}
          >
            New search
          </Button>
          <UserMenu
            theme={theme}
            onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
            onNavigate={goTab}
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
              searchFilter={searchFilter}
              onClearSearchFilter={() => setSearchFilter(null)}
              sourceFilter={sourceFilter}
              onClearSourceFilter={() => setSourceFilter(null)}
            />
          }
        />
        <Route
          path="/searches"
          element={
            <SearchesPage
              onViewHomes={viewSearchHomes}
              onViewAgents={viewAgents}
              pendingNew={pendingNew}
              onConsumedNew={() => setPendingNew(false)}
            />
          }
        />
        <Route
          path="/agents"
          element={
            <AgentsPage
              filter={agentFilter}
              onClearFilter={() => setAgentFilter(null)}
            />
          }
        />
        <Route
          path="/sources"
          element={
            <SourcesPage onViewLots={viewSourceLots} isOperator={isOperator} />
          }
        />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </div>
  );
}
