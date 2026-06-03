/**
 * SPA entrypoint — provider tree (Doxus pattern):
 *   trpc.Provider → QueryClientProvider → AuthProvider → BrowserRouter → App.
 *
 * AuthProvider wraps the router so App can gate routed content on the Supabase
 * sign-in status. The QueryClient is created via `useState(() => …)` so it is
 * stable across renders. index.css (Tailwind v4 + .sr-only) is imported once.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { trpc, trpcClient } from "./lib/trpc";
import { AuthProvider } from "./lib/auth";
import { App } from "./App";
import "./index.css";

function Root() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
      }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AuthProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
