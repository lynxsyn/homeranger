/**
 * App routes. `/listings` is the listings table; `/preferences` is the M5
 * search-profile editor; `/` redirects to listings. A tiny top nav links the two.
 */
import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { ListingsPage } from "./pages/ListingsPage";
import { PreferencesPage } from "./pages/PreferencesPage";

export function App() {
  return (
    <>
      <nav className="app-nav" aria-label="Primary">
        <NavLink to="/listings" data-testid="nav-listings">
          Listings
        </NavLink>
        <NavLink to="/preferences" data-testid="nav-preferences">
          Preferences
        </NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<Navigate to="/listings" replace />} />
        <Route path="/listings" element={<ListingsPage />} />
        <Route path="/preferences" element={<PreferencesPage />} />
      </Routes>
    </>
  );
}
