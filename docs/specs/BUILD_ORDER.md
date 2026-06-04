# homeranger — Spec Build Order

> **The only source of truth for what needs to be built.** Reasoning lives in `docs/plans/homeranger-plan.md` and `docs/decisions/`. The code itself is the truth of what's already built.
> When a spec ships: remove its row here AND delete `docs/specs/<name>.md` (+ `docs/plans/<name>.md` if any) in the same PR. No `✅ Done` markers. No "Last updated" narrative. No Parked / Deferred / historical sections. Append-only is a regression — delete on sight.
> M0 (decision gates) is **resolved** — see `docs/decisions/2026-06-01-*.md`. M1–M7 + the design-system listings UI + the full **Searches reframe** (PR1 entity/screen/link-through · PR2 listings refresh · PR3 launch loop) + **UK-wide location resolution + search autocomplete** (v0.13.0) + **per-search match scoring** (v0.29.0) have shipped. The discover→outreach→ingest→list loop is complete + operator-drivable; real **discovery is LIVE** in prod (`FIRECRAWL_API_KEY` wired, search launches query by place name). Real **sending** is still pending operator activation (Resend domain verification + `RESEND_FROM`).

## To build (top-down priority)

> The core product loop is built. The rows below are the next genuine enhancements (deferred during the Searches reframe), in priority order — pick one up when prioritised, or refresh from `docs/plans/homeranger-plan.md` + `docs/decisions/`.

| Name | Why | Sizing |
|---|---|---|
| match-rationale-ui | `listings.expand` already returns `scoreRationale`/`vectorScore`/`llmScore` (the hybrid scorer writes them) but the SPA renders only the numeric ScoreRing. Surface a "Why matched" tooltip/popover on the ring from the payload already there. No new embedding calls, no schema — pure disclosure of work already paid for. | S |
| similar-homes | "More like this" listing-to-listing recall reusing the existing `Listing.embedding` + `vectorTopK`: a self-excluding variant (`order by embedding <=> the row's vector`) + optional structured prefilter behind a `listings.similar(listingId,k)` endpoint + a row action. No new model calls, no schema change. | S |
| photo-taste-in-score | `PhotoAnalysis.tasteScore` (Haiku-vision per photo, 0-100) is computed + persisted but never ranks anything — `combinedScore` is only `wVec·vector + wLlm·llm`. Aggregate per-listing photo taste into a normalised term + a third `MATCH_WEIGHT_*` weight so genuinely attractive homes rank up. | S |
| extraction-enrichment | The listings UI surfaces `bathrooms` + a `tag` slot the extractor never fills (so baths always show "—" and no Auction/Planning tags appear). Extend the AI extractor to parse bathrooms + a short tag (e.g. "Auction", "Planning granted") from the agent email, add the nullable `Listing.tag` column, and render it. | S |
| semantic-optout-guard | `outreach-reply` opt-out detection is pure regex (`stop`/`unsubscribe`/…); a paraphrased opt-out ("please cease all correspondence") slips through — a PECR false-negative. Back the regex with an embedding-similarity check against canonical opt-out exemplars (UNION, can only over-suppress = safe), reusing the Voyage provider. | M |
| taste-feedback-centroid | Saved + dismissed listings are UI-only buckets today. Blend a saved-minus-dismissed embedding centroid (from already-stored vectors) into the match recall query so ranking learns from demonstrated taste. Needs a sample-size floor + empty-set no-op. | M |
