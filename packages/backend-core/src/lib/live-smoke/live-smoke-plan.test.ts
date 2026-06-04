import { describe, expect, it } from "vitest";
import {
  buildLiveSmokePlan,
  SMOKE_SCENARIOS,
  type LiveSmokeEnv,
} from "./live-smoke-plan.js";

// Synthetic .example addresses ONLY — never a real mailbox in the repo. Six
// distinct domains stand in for "one inbox per domain you own" (no cooldown
// clash). The real addresses live solely in the gitignored .env.live-smoke.
const SIX_DISTINCT: LiveSmokeEnv = {
  LIVE_SMOKE_AGENT_EMAILS: [
    "agent@alpha.example",
    "agent@bravo.example",
    "agent@charlie.example",
    "agent@delta.example",
    "agent@echo.example",
    "agent@foxtrot.example",
  ].join(","),
};

describe("buildLiveSmokePlan", () => {
  it("refuses to run when no agent emails are configured", () => {
    expect(() => buildLiveSmokePlan({})).toThrow(/LIVE_SMOKE_AGENT_EMAILS/);
    expect(() => buildLiveSmokePlan({ LIVE_SMOKE_AGENT_EMAILS: "   " })).toThrow(
      /LIVE_SMOKE_AGENT_EMAILS/,
    );
    expect(() =>
      buildLiveSmokePlan({ LIVE_SMOKE_AGENT_EMAILS: " , ,, " }),
    ).toThrow(/LIVE_SMOKE_AGENT_EMAILS/);
  });

  it("parses, trims, lower-cases and de-duplicates the email list", () => {
    const plan = buildLiveSmokePlan({
      LIVE_SMOKE_AGENT_EMAILS:
        " Agent@Alpha.Example , two@bravo.example ,agent@alpha.example",
    });
    expect(plan.agents.map((a) => a.email)).toEqual([
      "agent@alpha.example",
      "two@bravo.example",
    ]);
  });

  it("throws on a malformed address rather than silently dropping it", () => {
    expect(() =>
      buildLiveSmokePlan({ LIVE_SMOKE_AGENT_EMAILS: "not-an-email" }),
    ).toThrow(/not-an-email/);
    expect(() =>
      buildLiveSmokePlan({
        LIVE_SMOKE_AGENT_EMAILS: "ok@valid.example,no-dot@localhost",
      }),
    ).toThrow(/no-dot@localhost/);
  });

  it("classes every agent corporate_subscriber + not opted out (PECR gate 1)", () => {
    const plan = buildLiveSmokePlan(SIX_DISTINCT);
    expect(plan.agents).toHaveLength(6);
    for (const agent of plan.agents) {
      expect(agent.mailboxType).toBe("corporate_subscriber");
      expect(agent.optedOut).toBe(false);
      expect(agent.coveredOutcodes).toEqual(["SMOKE1"]);
    }
  });

  it("defaults the synthetic outcode to SMOKE1 and links the search to it", () => {
    const plan = buildLiveSmokePlan(SIX_DISTINCT);
    expect(plan.search.outcodes).toEqual(["SMOKE1"]);
    expect(plan.search.status).toBe("active");
    for (const agent of plan.agents) {
      expect(agent.coveredOutcodes).toEqual(plan.search.outcodes);
    }
  });

  it("honours an overridden outcode (trimmed + upper-cased) on both sides", () => {
    const plan = buildLiveSmokePlan({
      ...SIX_DISTINCT,
      LIVE_SMOKE_OUTCODE: " zz9 ",
    });
    expect(plan.search.outcodes).toEqual(["ZZ9"]);
    expect(plan.agents.every((a) => a.coveredOutcodes[0] === "ZZ9")).toBe(true);
  });

  it("assigns each curated scenario in order and labels the agency with it", () => {
    const plan = buildLiveSmokePlan(SIX_DISTINCT);
    expect(plan.agents.map((a) => a.scenario)).toEqual(
      SMOKE_SCENARIOS.map((s) => s.id),
    );
    // The agency name carries the scenario so the operator can tell the inboxes
    // apart in the Agents table.
    const first = SMOKE_SCENARIOS[0];
    expect(plan.agents[0].agencyName).toContain(first.label);
  });

  it("falls back to the spare scenario past the curated set", () => {
    const plan = buildLiveSmokePlan({
      LIVE_SMOKE_AGENT_EMAILS: [
        "a@one.example",
        "b@two.example",
        "c@three.example",
        "d@four.example",
        "e@five.example",
        "f@six.example",
        "g@seven.example",
      ].join(","),
    });
    expect(plan.agents).toHaveLength(7);
    expect(plan.agents[6].scenario).toBe("spare");
  });

  it("never puts an em dash in agency names (email-style preference)", () => {
    const plan = buildLiveSmokePlan(SIX_DISTINCT);
    for (const agent of plan.agents) {
      expect(agent.agencyName).not.toContain("—");
      expect(agent.agencyName).not.toContain("–");
    }
  });

  it("warns when two addresses share a domain (gate 4 cooldown collision)", () => {
    const plan = buildLiveSmokePlan({
      LIVE_SMOKE_AGENT_EMAILS: "one@shared.example,two@shared.example",
    });
    expect(plan.agents).toHaveLength(2);
    expect(plan.warnings.some((w) => w.includes("shared.example"))).toBe(true);
  });

  it("emits no domain-collision warning for the curated distinct-domain set", () => {
    const plan = buildLiveSmokePlan(SIX_DISTINCT);
    expect(plan.warnings).toEqual([]);
  });

  it("defaults a human, em-dash-free search brief and lets env override it", () => {
    const def = buildLiveSmokePlan(SIX_DISTINCT);
    expect(def.search.name.length).toBeGreaterThan(0);
    // Empty by default so Launch's discovery matches no real town (Firecrawl-safe).
    expect(def.search.location).toBe("");
    expect(def.search.keywords).not.toContain("—");

    const custom = buildLiveSmokePlan({
      ...SIX_DISTINCT,
      LIVE_SMOKE_SEARCH_NAME: "My smoke run",
      LIVE_SMOKE_SEARCH_LOCATION: "York",
      LIVE_SMOKE_SEARCH_KEYWORDS: "a quiet terrace with a south garden",
    });
    expect(custom.search.name).toBe("My smoke run");
    expect(custom.search.location).toBe("York");
    expect(custom.search.keywords).toBe("a quiet terrace with a south garden");
  });
});
