# homeranger — Spec Build Order

> **The only source of truth for what needs to be built.** Reasoning lives in `docs/plans/homeranger-plan.md` and `docs/decisions/`. The code itself is the truth of what's already built.
> When a spec ships: remove its row here AND delete `docs/specs/<name>.md` (+ `docs/plans/<name>.md` if any) in the same PR. No `✅ Done` markers. No "Last updated" narrative. No Parked / Deferred / historical sections. Append-only is a regression — delete on sight.
> M0 (decision gates) is **resolved** — see `docs/decisions/2026-06-01-*.md`. M1–M7 + the design-system listings UI + the full **Searches reframe** (PR1 entity/screen/link-through · PR2 listings refresh · PR3 launch loop) + **UK-wide location resolution + search autocomplete** (v0.13.0) have shipped. The discover→outreach→ingest→list loop is complete + operator-drivable; real **discovery is LIVE** in prod (`FIRECRAWL_API_KEY` wired, search launches query by place name). Real **sending** is still pending operator activation (Resend domain verification + `RESEND_FROM`).

## To build (top-down priority)

> The core product loop is built. The rows below are the next genuine enhancements (deferred during the Searches reframe), in priority order — pick one up when prioritised, or refresh from `docs/plans/homeranger-plan.md` + `docs/decisions/`.

| Name | Why | Sizing |
|---|---|---|
| per-search-match-scoring | Today the listing Match ring uses ONE global M5 SearchProfile (per-search scoring was deferred). Score each home against the taste of the search(s) whose outcodes it falls in, so a "Snowdonia detached-with-view" search and a "Hampstead 1-bed" search rank the same home differently. Embed each search's `keywords`; reuse the M5 vector + hybrid-score path keyed per search; surface the right search's score on the link-through. | M |
| extraction-enrichment | The listings UI surfaces `bathrooms` + a `tag` slot the extractor never fills (so baths always show "—" and no Auction/Planning tags appear). Extend the AI extractor to parse bathrooms + a short tag (e.g. "Auction", "Planning granted") from the agent email, add the nullable `Listing.tag` column, and render it. | S |
