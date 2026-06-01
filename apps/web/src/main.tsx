import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// M1 placeholder entrypoint — proves the web app builds + boots. The listings
// table, filters, and tRPC client are wired in M3.
const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <main>homescout — listings UI arrives in M3.</main>
    </StrictMode>,
  )
}
