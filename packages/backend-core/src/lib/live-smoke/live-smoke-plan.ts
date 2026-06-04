/**
 * buildLiveSmokePlan — the pure planner behind the live-email smoke seed
 * (apps/api/prisma/seed-live-smoke.ts). It turns a handful of env vars (the
 * mailboxes you OWN, sourced from the shell / a gitignored .env.live-smoke so no
 * personal address is ever committed) into a deterministic seed plan: one
 * operator search plus one Agent per inbox, each mapped to a test scenario.
 *
 * Why these shapes are load-bearing for a REAL send/receive round-trip:
 *   - mailboxType = "corporate_subscriber": ComplianceGuard gate 1 (PECR) blocks
 *     any send to an individual/unknown mailbox. Free-mail addresses you own
 *     would normally classify `individual`; marking them corporate_subscriber is
 *     a deliberate "I own this mailbox" override for self-testing only.
 *   - coveredOutcodes = the search's synthetic outcode: searches.reviewDrafts
 *     lists agents BY OUTCODE, so the seeded inboxes show up in the search's
 *     review/approve flow with no Firecrawl discovery (dormant in prod) needed.
 *   - distinct domains: gate 4 (per-domain cooldown) treats one email domain as
 *     one agency and blocks all-but-one cold send per window — the planner warns
 *     when two inboxes collide so you pick distinct domains.
 *
 * Pure + deterministic (env in, plan out) so it is unit-tested without a DB; the
 * seed script owns the thin idempotent upserts.
 */
import { emailDomain } from "../email/email-domain.js";

/** The env surface the planner reads (a subset of process.env). */
export type LiveSmokeEnv = Record<string, string | undefined>;

export type LiveSmokeScenarioId =
  | "reply_with_listing"
  | "reply_plain"
  | "reply_stop"
  | "click_unsubscribe"
  | "no_reply"
  | "spare";

export interface LiveSmokeScenario {
  id: LiveSmokeScenarioId;
  /** Short label woven into the agency name + shown in the Agents table. */
  label: string;
  /** What the operator does with this inbox (logged + echoed in the runbook). */
  instruction: string;
}

/** Spare scenario — the fallback for any inbox past the curated set. */
const SPARE_SCENARIO: LiveSmokeScenario = {
  id: "spare",
  label: "spare mailbox",
  instruction:
    "Spare inbox for ad-hoc checks (deliverability, the warm-up daily cap).",
};

/**
 * The curated test matrix, in order. The seed assigns scenario[i] to the i-th
 * configured inbox; inboxes past the list fall back to the spare scenario.
 */
export const SMOKE_SCENARIOS: readonly LiveSmokeScenario[] = [
  {
    id: "reply_with_listing",
    label: "reply with a listing",
    instruction:
      "Reply from this inbox with a short property (street address + asking price). Inbound parsing should extract a listing and the thread should advance to replied.",
  },
  {
    id: "reply_plain",
    label: "reply normally",
    instruction:
      "Reply with a plain message (no property details). The thread should advance to replied with no new listing.",
  },
  {
    id: "reply_stop",
    label: "reply STOP to opt out",
    instruction:
      "Reply with the single word STOP. The address should be suppressed, the agent opted out, and the thread closed.",
  },
  {
    id: "click_unsubscribe",
    label: "use the unsubscribe link",
    instruction:
      "Open the one-click unsubscribe link in the email footer. The address should be suppressed via the RFC 8058 route.",
  },
  {
    id: "no_reply",
    label: "leave unanswered",
    instruction:
      "Do not reply. After the follow-up window the scheduler should send exactly one follow-up on the same thread.",
  },
  SPARE_SCENARIO,
];

export interface LiveSmokeAgentSpec {
  email: string;
  agencyName: string;
  scenario: LiveSmokeScenarioId;
  coveredOutcodes: string[];
  /** PECR gate 1 needs this exact value or the send is blocked. */
  mailboxType: "corporate_subscriber";
  optedOut: false;
}

export interface LiveSmokeSearchSpec {
  name: string;
  location: string;
  outcodes: string[];
  keywords: string;
  status: "active";
}

export interface LiveSmokePlan {
  search: LiveSmokeSearchSpec;
  agents: LiveSmokeAgentSpec[];
  /** Non-fatal advisories (e.g. domain-cooldown collisions) for the operator. */
  warnings: string[];
}

const DEFAULT_OUTCODE = "SMOKE1";
const DEFAULT_SEARCH_NAME = "Live email smoke test";
// EMPTY on purpose. Firecrawl agent discovery is LIVE in prod, so a real place
// name here makes the search's Launch scrape real estate agents in that town and
// stamp them into the SMOKE1 patch (a hazard: re-Launch + approve-all would cold
// email real agents). Empty → the draft subject reads "A private buyer looking in
// your area" (clean) and Launch's outcode-fallback query matches no real town.
// To send with ZERO Firecrawl, skip Launch entirely and use `pnpm smoke:send`.
const DEFAULT_SEARCH_LOCATION = "";
// Woven into the first email as prose by draftSearchEmail; kept human and
// em-dash-free per the operator outreach-style preference (em dashes read as an
// AI tell to estate agents and hurt deliverability).
const DEFAULT_SEARCH_KEYWORDS =
  "a characterful period home with original features, a decent garden and good natural light; ideally something with a bit of potential to make my own";

function envStr(env: LiveSmokeEnv, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : fallback;
}

export function buildLiveSmokePlan(env: LiveSmokeEnv): LiveSmokePlan {
  // Parse → trim → lower-case → de-dup (first-seen order preserved).
  const parsed = (env.LIVE_SMOKE_AGENT_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const emails: string[] = [];
  for (const email of parsed) {
    if (!emails.includes(email)) {
      emails.push(email);
    }
  }

  if (emails.length === 0) {
    throw new Error(
      "LIVE_SMOKE_AGENT_EMAILS is required (comma-separated mailboxes you own) — refusing to seed live-smoke agents with no recipients.",
    );
  }

  // Validate every address up front. A silent drop would create an unsendable
  // agent that only fails (confusingly) at send time inside the guard.
  for (const email of emails) {
    if (emailDomain(email) === null) {
      throw new Error(
        `LIVE_SMOKE_AGENT_EMAILS contains a malformed address: ${email}`,
      );
    }
  }

  const outcode = envStr(env, "LIVE_SMOKE_OUTCODE", DEFAULT_OUTCODE).toUpperCase();

  const agents: LiveSmokeAgentSpec[] = emails.map((email, index) => {
    const scenario = SMOKE_SCENARIOS[index] ?? SPARE_SCENARIO;
    return {
      email,
      agencyName: `Smoke Test: ${scenario.label}`,
      scenario: scenario.id,
      coveredOutcodes: [outcode],
      mailboxType: "corporate_subscriber",
      optedOut: false,
    };
  });

  // Gate 4 (per-domain cooldown) collapses one email domain to one "agency": a
  // second cold send to the same domain inside DOMAIN_COOLDOWN_DAYS is blocked.
  // Warn so the operator picks distinct domains (or sets DOMAIN_COOLDOWN_DAYS=0).
  const byDomain = new Map<string, string[]>();
  for (const email of emails) {
    const domain = emailDomain(email);
    if (domain === null) {
      continue; // unreachable (validated above) — keeps the strict types honest
    }
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), email]);
  }
  const warnings: string[] = [];
  for (const [domain, members] of byDomain) {
    if (members.length > 1) {
      warnings.push(
        `${members.length} addresses share domain ${domain} (${members.join(
          ", ",
        )}); the per-domain cooldown (compliance gate 4) blocks all but one cold send per DOMAIN_COOLDOWN_DAYS. Use distinct domains or set DOMAIN_COOLDOWN_DAYS=0 for the test.`,
      );
    }
  }

  const search: LiveSmokeSearchSpec = {
    name: envStr(env, "LIVE_SMOKE_SEARCH_NAME", DEFAULT_SEARCH_NAME),
    location: envStr(env, "LIVE_SMOKE_SEARCH_LOCATION", DEFAULT_SEARCH_LOCATION),
    outcodes: [outcode],
    keywords: envStr(env, "LIVE_SMOKE_SEARCH_KEYWORDS", DEFAULT_SEARCH_KEYWORDS),
    status: "active",
  };

  return { search, agents, warnings };
}
