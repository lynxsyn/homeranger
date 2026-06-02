# homescout — Spec Build Order

> **The only source of truth for what needs to be built.** Reasoning lives in `docs/plans/homescout-plan.md` and `docs/decisions/`. The code itself is the truth of what's already built.
> When a spec ships: remove its row here AND delete `docs/specs/<name>.md` (+ `docs/plans/<name>.md` if any) in the same PR. No `✅ Done` markers. No "Last updated" narrative. No Parked / Deferred / historical sections. Append-only is a regression — delete on sight.
> M0 (decision gates) is **resolved** — see `docs/decisions/2026-06-01-*.md`. M1–M7 + the design-system listings UI + Scouts PR1 (the Scout entity, screen, and listings link-through) have shipped; the Scouts reframe continues below.

## To build (top-down priority)

> **Product reframe (2026-06-02, operator):** the app is the discover→outreach→ingest→table LOOP, organised around **SCOUTS** — saved buyer briefs (a named region/area + property/condition/land/sale rules + free-text taste) that drive outreach. The operator creates a scout; the system DISCOVERS estate agents in its outcodes, cold-emails them (ComplianceGuard-gated) with the brief woven in, and replies populate the listings table (filter-free; no scraped status — only what the agent's email gives). Each scout links through to the homes it found, by outcode. "Campaign" is never used in code — it's a Scout.

| Name | Why | Sizing |
|---|---|---|
| scouts-pr2-listings-refresh | The listings table catches up to the Scouts design: REMOVE listing status (no pre_market/live badges — homescout doesn't scrape portals, so status is guesswork; meta line becomes "N homes from your agents"), add bookmark → per-agency follow-ups (one warm note per agency, reviewed before send), listing tags (e.g. a gold "Auction") + land/null-beds. Built in the HomeScout design system. E2E: bookmark homes → draft per-agency follow-ups; status badges gone. | M |
| scouts-pr3-launch-outreach | The scout LAUNCH loop: `scout.launch` runs M7 `discover:agents` for the scout's outcodes, then prepares ComplianceGuard-checked outreach DRAFTS (the brief woven in via `draftScoutEmail`) for operator REVIEW before anything sends (PECR-boundary checkpoint); approving reuses the live M6 guarded-send path. Surface the kill-switch + per-scout agents-contacted / homes-found stats. E2E: launch (fake discovery + send) → reviewed drafts → approve → guarded send; kill-switch halts. | L |
