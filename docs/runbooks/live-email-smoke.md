# Runbook: live email smoke test

Exercise the **real** send → receive → reply round-trip using mailboxes **you
own** as stand-in estate agents. Unlike the E2E suite (which runs under
`OUTREACH_FAKE=1` and never dispatches mail), this drives a deployed environment
where Resend actually delivers and the `homeranger.app` inbound webhook links
replies back to their threads.

The seed is `apps/api/prisma/seed-live-smoke.ts` (planner:
`packages/backend-core/src/lib/live-smoke/live-smoke-plan.ts`). It is **separate**
from `prisma/seed.ts` on purpose — the E2E seed must stay deterministic and free
of personal addresses.

## What it creates

- **One operator search** (`userId IS NULL`) on a synthetic outcode (`SMOKE1` by
  default). The search's outcode is what links the seeded agents into its
  review/approve flow.
- **One `Agent` per mailbox you configure**, each `mailboxType =
  corporate_subscriber` (so PECR gate 1 lets the send through) and
  `coveredOutcodes = [SMOKE1]`. Each is labelled with a test scenario:

  | # | Scenario | What you do with the inbox |
  |---|----------|----------------------------|
  | 1 | `reply_with_listing` | Reply with a property (address + asking price) → inbound parsing extracts a listing, thread → `replied`. |
  | 2 | `reply_plain` | Reply with a plain message → thread → `replied`, no listing. |
  | 3 | `reply_stop` | Reply `STOP` → `SuppressionEntry` + agent `optedOut` + thread `closed`. |
  | 4 | `click_unsubscribe` | Click the footer one-click link → suppressed via the RFC 8058 route. |
  | 5 | `no_reply` | Do nothing → after the follow-up window the scheduler sends one follow-up. |
  | 6+ | `spare` | Spare inbox (deliverability / warm-up cap checks). |

## Why a curated set of distinct domains

Compliance **gate 5** (per-domain cooldown) treats one email *domain* as one
agency and blocks all-but-one cold send per `DOMAIN_COOLDOWN_DAYS` (default 30).
So five aliases on one provider give you **one** sendable agent, not five. Pick
one mailbox **per distinct domain** (the seed warns if two collide). The order
maps to the scenarios above:

```
you@protonmail.com        # reply_with_listing
you@proton.me             # reply_plain     (proton.me, pm.me and protonmail.com
you@pm.me                 # reply_stop       are THREE distinct domains)
you@your-domain-a.tld     # click_unsubscribe
you@your-domain-b.tld     # no_reply
you@your-domain-c.tld     # spare
```

> `+tag` sub-addressing does **not** dodge gate 5 — it keys on the domain.

## 1. Configure the mailboxes (kept out of git)

Addresses come from the environment, never the repo. Put **your** real addresses
in a **gitignored** `.env.live-smoke` at the repo root (`.env.*` is already
ignored), using the placeholders above as the shape:

```sh
# .env.live-smoke  (repo root; never committed)
LIVE_SMOKE_AGENT_EMAILS="you@protonmail.com,you@proton.me,you@pm.me,you@your-domain-a.tld,you@your-domain-b.tld,you@your-domain-c.tld"
# Optional overrides:
# LIVE_SMOKE_OUTCODE="SMOKE1"
# LIVE_SMOKE_SEARCH_NAME="Live email smoke test"
# LIVE_SMOKE_SEARCH_LOCATION="Bath"
# LIVE_SMOKE_SEARCH_KEYWORDS="a characterful period home with a decent garden..."
```

The planner refuses to run with no `LIVE_SMOKE_AGENT_EMAILS`, so it can never
fire by accident or in CI.

## 2. Point at the deployed database (pve1)

The cluster Postgres is in-cluster only, so port-forward it and run the seed
locally against the forward.

```sh
# A) password from the live secret (namespace homeranger, secret homeranger-secret)
DB_URL=$(kubectl -n homeranger get secret homeranger-secret \
  -o jsonpath='{.data.DATABASE_URL}' | base64 -d)
PW=$(printf '%s' "$DB_URL" | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#')

# B) forward the cluster Postgres to localhost:5440
kubectl -n homeranger port-forward svc/homeranger-postgres 5440:5432 &

# C) run the seed against the forward (it prints the target + recipients first,
#    then writes ONLY with LIVE_SMOKE_CONFIRM=1)
export DATABASE_URL="postgresql://homeranger:${PW}@localhost:5440/homeranger"
LIVE_SMOKE_CONFIRM=1 pnpm --filter @homeranger/api db:seed:live-smoke
```

> The seed always prints the target host + the exact recipient list and refuses
> to write unless `LIVE_SMOKE_CONFIRM=1` is set — so a forgotten `kubectl`
> context (a port-forward looks like `localhost`) can't write silently. **Read
> the printed host before confirming.** Run once without the flag to preview.

## 3. Pre-flight (operator surface)

- Outreach must be **live**, not paused: Settings → Outreach, kill-switch OFF.
- The warm-up daily cap (`WarmupState.dailyCap`, default 20) must exceed the
  number of agents you intend to send to today.
- Your buyer identity in Settings → "Your details" signs the email — set it so
  the sign-off reads naturally.

## 4. Send

> ⚠️ **Firecrawl is LIVE in prod.** Clicking **Launch** enqueues a real discovery
> search for the search's outcode. The seed now defaults the search **location to
> empty**, so the query falls back to the synthetic outcode (`estate agents in
> SMOKE1, UK`) and matches no real town — but it is still ~1 Firecrawl call, and a
> real `LIVE_SMOKE_SEARCH_LOCATION` would scrape real agents in that town into the
> patch. **In the review, tick ONLY the "Smoke Test:" agents — never "approve
> all"** (a stray discovered agent must not be cold-emailed). The review reads the
> seeded agents by outcode regardless of discovery.

1. `/searches` → open **"Live email smoke test"** → **Launch**.
2. The review modal lists your 6 **"Smoke Test:"** inboxes as eligible. Tick ONLY
   those, and review the woven draft.
3. **Approve & send.** Real emails dispatch to your inboxes via Resend.

> To send with **zero Firecrawl** (skip Launch + discovery entirely), a
> `smoke:send` direct-enqueue tool is the intended path — not yet built; ask for it.

## 5. Receive + reply

Outreach is sent `From: HomeRanger <noreply@homeranger.app>`, and the apex MX is
wired to Resend inbound → `homeranger.app/webhooks/resend/inbound`. So just
**Reply** from each inbox; the reply lands at the webhook, is matched to its
`Agent` by sender email, and advances the thread. Watch `/agents` (or the search
stats) flip `awaiting_reply` → `replied`/`closed` per the scenario table above.

## 6. Cleanup

The seed prints the exact cleanup `DELETE` (with the real search name) when it
finishes. The default-name version:

```sql
DELETE FROM "OutreachMessage" WHERE "threadId" IN (
  SELECT t.id FROM "OutreachThread" t JOIN "Agent" a ON a.id=t."agentId"
  WHERE 'SMOKE1' = ANY(a."coveredOutcodes"));
DELETE FROM "OutreachThread" WHERE "agentId" IN (
  SELECT id FROM "Agent" WHERE 'SMOKE1' = ANY("coveredOutcodes"));
DELETE FROM "Agent"  WHERE 'SMOKE1' = ANY("coveredOutcodes");
DELETE FROM "Search" WHERE "userId" IS NULL AND name = 'Live email smoke test';
-- Re-testing the STOP / unsubscribe scenario also needs the suppression cleared:
DELETE FROM "SuppressionEntry" WHERE email = '<that-inbox>';
```

> If you set `LIVE_SMOKE_SEARCH_NAME` or `LIVE_SMOKE_OUTCODE`, substitute them in
> the `name = ...` / `'SMOKE1'` clauses (use the values the seed printed).

Re-running the seed is idempotent (search found-or-updated by name; agents
upserted by email; `optedOut` reset to false). **Ordering for scenarios 3 / 4:**
after a STOP/unsubscribe the agent is `optedOut`/suppressed and disappears from
the review modal (`reviewDrafts` hides opted-out agents); to re-test, first
re-run the seed (resets `optedOut`) **and** delete the `SuppressionEntry`, then
Launch again.

## Notes

- Email copy stays em-dash-free and tone-matched to your urgency setting (an AI
  tell to estate agents); the default search keywords follow that preference.
- A reply from a mailbox whose address is **not** a tracked agent is ignored by
  the reply linker — reply from the same address that was emailed.
