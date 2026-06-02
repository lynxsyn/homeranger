/**
 * App routes. `/listings` is the M3 listings table; `/` redirects to it (the
 * only surface in M3).
 */
import { Navigate, Route, Routes } from "react-router-dom";
import { ListingsPage } from "./pages/ListingsPage";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/listings" replace />} />
      <Route path="/listings" element={<ListingsPage />} />
    </Routes>
  );
}
