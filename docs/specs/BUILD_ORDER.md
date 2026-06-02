# homescout — Spec Build Order

> **The only source of truth for what needs to be built.** Reasoning lives in `docs/plans/homescout-plan.md` and `docs/decisions/`. The code itself is the truth of what's already built.
> When a spec ships: remove its row here AND delete `docs/specs/<name>.md` (+ `docs/plans/<name>.md` if any) in the same PR. No `✅ Done` markers. No "Last updated" narrative. No Parked / Deferred / historical sections. Append-only is a regression — delete on sight.
> M0 (decision gates) is **resolved** — see `docs/decisions/2026-06-01-*.md`. Build starts at M7 (M1–M6 shipped).

## To build (top-down priority)

> **Product reframe (2026-06-02, operator):** the app is the discover→outreach→ingest→table LOOP. The operator sets a UK region (by name, e.g. Conwy County) + free-text requirements; the system DISCOVERS estate agents in that region, cold-emails them (ComplianceGuard-gated) with the requirements woven in, and their replies populate a filter-free listings table. This replaces the M7-dashboard spec.

| Name | Why | Sizing |
|---|---|---|
| M7-region-agent-discovery | The new core capability the loop needs: a built-in UK region-name → postcode-outcode map, and an `AgentDiscoveryProvider` (web search/extract behind an interface + env-gated fake) that finds estate agents in a region, classifies mailbox type (business-domain ⇒ `corporate_subscriber`, free-mail ⇒ `individual`), and upserts them as `Agent`s with `coveredOutcodes`. A `discover:agents` job runs it. Compliance: sourcing public business contacts on a documented legitimate-interest basis; the ComplianceGuard still gates every SEND (corporate-only). See `docs/specs/M7-region-agent-discovery.md`. | L |
| M8-campaign-loop | The visible loop: a `CampaignPage` (pick region + write requirements → launch) that triggers discovery + ComplianceGuard-gated outreach with the requirements woven into the draft; the listings table stripped of filters/sort (just the list of what agents sent); the kill-switch surfaced as the safety control. E2E: launch a campaign (fake discovery + fake send) → guarded sends → kill-switch halts them. | M |
