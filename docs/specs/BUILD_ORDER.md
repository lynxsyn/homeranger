# homescout — Spec Build Order

> **The only source of truth for what needs to be built.** Reasoning lives in `docs/plans/homescout-plan.md` and `docs/decisions/`. The code itself is the truth of what's already built.
> When a spec ships: remove its row here AND delete `docs/specs/<name>.md` (+ `docs/plans/<name>.md` if any) in the same PR. No `✅ Done` markers. No "Last updated" narrative. No Parked / Deferred / historical sections. Append-only is a regression — delete on sight.
> M0 (decision gates) is **resolved** — see `docs/decisions/2026-06-01-*.md`. M1–M7 + the design-system listings UI + the full **Scouts reframe** (PR1 entity/screen/link-through · PR2 listings refresh · PR3 launch loop) have shipped. The discover→outreach→ingest→list loop is complete + operator-drivable; real discovery/sending in prod is dormant pending operator activation (Resend domain verification + `FIRECRAWL_API_KEY`).

## To build (top-down priority)

> The core product loop is built. The rows below are the next genuine enhancements (deferred during the Scouts reframe), in priority order — pick one up when prioritised, or refresh from `docs/plans/homescout-plan.md` + `docs/decisions/`.

| Name | Why | Sizing |
|---|---|---|
| per-scout-match-scoring | Today the listing Match ring uses ONE global M5 SearchProfile (per-scout scoring was deferred). Score each home against the taste of the scout(s) whose outcodes it falls in, so a "Snowdonia detached-with-view" scout and a "Hampstead 1-bed" scout rank the same home differently. Embed each scout's `keywords`; reuse the M5 vector + hybrid-score path keyed per scout; surface the right scout's score on the link-through. | M |
| extraction-enrichment | The listings UI surfaces `bathrooms` + a `tag` slot the extractor never fills (so baths always show "—" and no Auction/Planning tags appear). Extend the AI extractor to parse bathrooms + a short tag (e.g. "Auction", "Planning granted") from the agent email, add the nullable `Listing.tag` column, and render it. | S |
