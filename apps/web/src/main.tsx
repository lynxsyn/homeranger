/**
 * SPA entrypoint — provider tree (Doxus pattern):
 *   trpc.Provider → QueryClientProvider → BrowserRouter → App.
 *
 * The QueryClient is created via `useState(() => …)` so it is stable across
 * renders. staleTime/retry mirror Doxus. index.css (Tailwind v4 + .sr-only) is
 * imported once here.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { trpc, trpcClient } from "./lib/trpc";
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
        <BrowserRouter>
          <App />
        </BrowserRouter>
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
