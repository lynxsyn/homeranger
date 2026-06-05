import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultAgentDiscoveryService,
  classifyMailboxType,
  agentWebsite,
  pickBestEmail,
  getAgentDiscoveryService,
  _setAgentDiscoveryServiceForTesting,
} from "./agent-discovery.service.js";
import type {
  AgentDiscoveryProvider,
  DiscoveredAgent,
} from "../lib/discovery/agent-discovery.provider.js";
import type { AgentRepository } from "../repositories/agent.repository.js";
import type { SuppressionEntryRepository } from "../repositories/suppression-entry.repository.js";
import type {
  AgentClassifier,
  AgentClassifyResult,
} from "../lib/ai/agent-classifier.provider.js";

describe("classifyMailboxType", () => {
  it("classifies a business/agency domain as corporate_subscriber", () => {
    expect(classifyMailboxType("info@conwy-estates.co.uk")).toBe(
      "corporate_subscriber",
    );
    expect(classifyMailboxType("sales@AgencyName.com")).toBe(
      "corporate_subscriber",
    );
  });

  it("classifies free webmail as individual", () => {
    expect(classifyMailboxType("joe.bloggs@gmail.com")).toBe("individual");
    expect(classifyMailboxType("agent@yahoo.co.uk")).toBe("individual");
  });

  it("classifies a malformed address as unknown", () => {
    expect(classifyMailboxType("not-an-email")).toBe("unknown");
    expect(classifyMailboxType("x@nodot")).toBe("unknown");
    expect(classifyMailboxType("@leading.com")).toBe("unknown");
  });
});

describe("agentWebsite", () => {
  it("prefers the provider's scraped website URL when present (http(s) kept verbatim)", () => {
    expect(
      agentWebsite(
        "info@conwy-estates.co.uk",
        "https://conwy-estates.co.uk/contact",
      ),
    ).toBe("https://conwy-estates.co.uk/contact");
    expect(agentWebsite("info@a.co.uk", "http://a.co.uk")).toBe(
      "http://a.co.uk",
    );
  });

  it("prepends https:// to a protocol-less scraped URL so it is an absolute link", () => {
    expect(agentWebsite("info@conwy-estates.co.uk", "conwy-estates.co.uk")).toBe(
      "https://conwy-estates.co.uk",
    );
  });

  it("derives https://<domain> from the email when no URL is scraped", () => {
    expect(agentWebsite("info@conwy-estates.co.uk")).toBe(
      "https://conwy-estates.co.uk",
    );
    // A blank/whitespace scraped URL is treated as absent → derive from domain.
    expect(agentWebsite("sales@AgencyName.com", "   ")).toBe(
      "https://agencyname.com",
    );
  });

  it("returns null for a malformed address with no domain", () => {
    expect(agentWebsite("not-an-email")).toBeNull();
  });
});

interface Harness {
  service: DefaultAgentDiscoveryService;
  discover: ReturnType<typeof vi.fn>;
  upsertByEmail: ReturnType<typeof vi.fn>;
  isSuppressed: ReturnType<typeof vi.fn>;
  classify: ReturnType<typeof vi.fn>;
}

/** A KEEP verdict (a genuine residential sales agency) — the default for tests. */
function keepVerdict(): AgentClassifyResult {
  return {
    isResidentialSalesAgency: true,
    kind: "estate_agent",
    confidence: 1,
    suggestedName: "",
    metrics: {
      model: "stub",
      inputTokens: 0,
      outputTokens: 0,
      costPence: 0,
      durationMs: 0,
    },
  };
}

/** A CONFIDENT non-agency verdict (>= the 0.85 auto-delete threshold). */
function confidentJunkVerdict(
  kind: AgentClassifyResult["kind"] = "portal",
): AgentClassifyResult {
  return { ...keepVerdict(), isResidentialSalesAgency: false, kind, confidence: 0.95 };
}

/** An UNCERTAIN non-agency verdict (below the threshold) — KEPT, not deleted. */
function uncertainJunkVerdict(): AgentClassifyResult {
  return {
    ...keepVerdict(),
    isResidentialSalesAgency: false,
    kind: "other",
    confidence: 0.4,
  };
}

function makeHarness(opts: {
  agents: DiscoveredAgent[];
  suppressed?: string[];
  /**
   * The classifier verdict, by email or a single default. Omit to wire NO
   * classifier (the gate is then a no-op — every survivor KEPT).
   */
  classifyBy?: (email: string) => AgentClassifyResult;
}): Harness {
  const discover = vi.fn().mockResolvedValue(opts.agents);
  const upsertByEmail = vi.fn().mockResolvedValue({});
  const suppressedSet = new Set(opts.suppressed ?? []);
  const isSuppressed = vi.fn(async (email: string) => suppressedSet.has(email));
  const classify = vi.fn(async (input: { email: string }) =>
    (opts.classifyBy ?? (() => keepVerdict()))(input.email),
  );

  const service = new DefaultAgentDiscoveryService({
    provider: { discover } as unknown as AgentDiscoveryProvider,
    agentRepository: { upsertByEmail } as unknown as AgentRepository,
    suppressionEntryRepository: {
      isSuppressed,
    } as unknown as SuppressionEntryRepository,
    ...(opts.classifyBy
      ? { classifier: { classify } as unknown as AgentClassifier }
      : {}),
  });
  return { service, discover, upsertByEmail, isSuppressed, classify };
}

afterEach(() => {
  delete process.env.ANALYSIS_KILL_SWITCH;
  vi.restoreAllMocks();
});

describe("AgentDiscoveryService.discoverRegion", () => {
  it("upserts corporate agents (with a derived website) and DROPS free-mail", async () => {
    const h = makeHarness({
      agents: [
        { email: "info@conwy-estates.co.uk", agencyName: "Conwy Estates" },
        { email: "joe@gmail.com", agencyName: "Joe (sole trader)" },
      ],
    });
    const result = await h.service.discoverRegion("Conwy County");

    expect(h.discover).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "Conwy County",
        outcodes: expect.arrayContaining(["LL30"]),
      }),
    );
    // Business domain → corporate_subscriber, with the region outcodes AND a
    // website derived from the email domain (no scraped websiteUrl supplied).
    expect(h.upsertByEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "info@conwy-estates.co.uk",
        mailboxType: "corporate_subscriber",
        coveredOutcodes: expect.arrayContaining(["LL32"]),
        website: "https://conwy-estates.co.uk",
      }),
    );
    // Free webmail (gmail) is DROPPED at discovery — never persisted. PECR: a
    // personal mailbox is not a corporate subscriber, so it is never cold-emailable.
    expect(h.upsertByEmail).toHaveBeenCalledTimes(1);
    expect(h.upsertByEmail).not.toHaveBeenCalledWith(
      expect.objectContaining({ email: "joe@gmail.com" }),
    );
    expect(result).toEqual({
      discovered: 2,
      upserted: 1,
      skipped: 1,
      collapsed: 0,
      classifiedOut: 0,
    });
  });

  it("skips already-suppressed emails (never re-sourced)", async () => {
    const h = makeHarness({
      agents: [
        { email: "info@a.co.uk", agencyName: "A" },
        { email: "info@b.co.uk", agencyName: "B" },
      ],
      suppressed: ["info@b.co.uk"],
    });
    const result = await h.service.discoverRegion("Conwy County");
    expect(h.upsertByEmail).toHaveBeenCalledTimes(1);
    expect(h.upsertByEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "info@a.co.uk" }),
    );
    expect(result).toEqual({
      discovered: 2,
      upserted: 1,
      skipped: 1,
      collapsed: 0,
      classifiedOut: 0,
    });
  });

  it("skips a malformed (unknown) address — never persisted", async () => {
    const h = makeHarness({
      agents: [
        { email: "info@a.co.uk", agencyName: "A" },
        { email: "not-an-email", agencyName: "Broken" },
      ],
    });
    const result = await h.service.discoverRegion("Conwy County");
    expect(h.upsertByEmail).toHaveBeenCalledTimes(1);
    expect(h.upsertByEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "info@a.co.uk" }),
    );
    expect(result).toEqual({
      discovered: 2,
      upserted: 1,
      skipped: 1,
      collapsed: 0,
      classifiedOut: 0,
    });
  });

  it("dedups duplicate emails within a batch (counted once)", async () => {
    const h = makeHarness({
      agents: [
        { email: "info@a.co.uk", agencyName: "A" },
        { email: "INFO@a.co.uk", agencyName: "A (dupe, different case)" },
      ],
    });
    const result = await h.service.discoverRegion("Conwy County");
    expect(h.upsertByEmail).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      discovered: 2,
      upserted: 1,
      skipped: 1,
      collapsed: 0,
      classifiedOut: 0,
    });
  });

  it("is a no-op for an unsupported region (provider not called)", async () => {
    const h = makeHarness({ agents: [] });
    const result = await h.service.discoverRegion("Atlantis");
    expect(h.discover).not.toHaveBeenCalled();
    expect(result).toEqual({
      discovered: 0,
      upserted: 0,
      skipped: 0,
      collapsed: 0,
      classifiedOut: 0,
    });
  });
});

describe("AgentDiscoveryService.discoverByOutcodes", () => {
  it("discovers + upserts over an EXPLICIT outcode set, passing the scraped website through", async () => {
    const h = makeHarness({
      agents: [
        {
          email: "info@conwy-estates.co.uk",
          agencyName: "Conwy Estates",
          websiteUrl: "https://conwy-estates.co.uk/about",
        },
        { email: "joe@gmail.com", agencyName: "Joe (sole trader)" },
      ],
    });
    const result = await h.service.discoverByOutcodes(["LL30", "LL31"]);

    // The provider gets the explicit outcodes verbatim (no regionToOutcodes).
    expect(h.discover).toHaveBeenCalledWith(
      expect.objectContaining({ outcodes: ["LL30", "LL31"] }),
    );
    // Upserts stamp the SAME explicit outcodes + the provider's scraped website.
    expect(h.upsertByEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "info@conwy-estates.co.uk",
        mailboxType: "corporate_subscriber",
        coveredOutcodes: ["LL30", "LL31"],
        website: "https://conwy-estates.co.uk/about",
      }),
    );
    // gmail dropped (free-mail) — only the corporate agent is persisted.
    expect(h.upsertByEmail).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      discovered: 2,
      upserted: 1,
      skipped: 1,
      collapsed: 0,
      classifiedOut: 0,
    });
  });

  it("uses the place-name regionLabel as the provider query (not the raw outcodes)", async () => {
    // The search-launch fix: a web search for "LL30, LL31" finds nothing, so the
    // search's human place name ("Conwy County") MUST drive the provider query —
    // while the explicit outcodes still get stamped on the discovered agents.
    const h = makeHarness({
      agents: [{ email: "info@conwy-estates.co.uk", agencyName: "Conwy Estates" }],
    });
    await h.service.discoverByOutcodes(["LL30", "LL31"], "Conwy County");
    expect(h.discover).toHaveBeenCalledWith({
      region: "Conwy County",
      outcodes: ["LL30", "LL31"],
    });
    expect(h.upsertByEmail).toHaveBeenCalledWith(
      expect.objectContaining({ coveredOutcodes: ["LL30", "LL31"] }),
    );
  });

  it("falls back to the joined outcodes when no regionLabel is supplied", async () => {
    const h = makeHarness({
      agents: [{ email: "info@a.co.uk", agencyName: "A" }],
    });
    await h.service.discoverByOutcodes(["LL30", "LL31"]);
    expect(h.discover).toHaveBeenCalledWith({
      region: "LL30, LL31",
      outcodes: ["LL30", "LL31"],
    });
  });

  it("treats a blank regionLabel as absent and falls back to the outcodes", async () => {
    const h = makeHarness({
      agents: [{ email: "info@a.co.uk", agencyName: "A" }],
    });
    await h.service.discoverByOutcodes(["LL30"], "   ");
    expect(h.discover).toHaveBeenCalledWith({
      region: "LL30",
      outcodes: ["LL30"],
    });
  });

  it("normalises + dedups the outcode set (case + blanks + dupes)", async () => {
    const h = makeHarness({
      agents: [{ email: "info@a.co.uk", agencyName: "A" }],
    });
    await h.service.discoverByOutcodes(["ll30", " LL30 ", "", "LL31"]);
    expect(h.discover).toHaveBeenCalledWith(
      expect.objectContaining({ outcodes: ["LL30", "LL31"] }),
    );
  });

  it("skips already-suppressed emails (never re-sourced)", async () => {
    const h = makeHarness({
      agents: [
        { email: "info@a.co.uk", agencyName: "A" },
        { email: "info@b.co.uk", agencyName: "B" },
      ],
      suppressed: ["info@b.co.uk"],
    });
    const result = await h.service.discoverByOutcodes(["LL30"]);
    expect(h.upsertByEmail).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      discovered: 2,
      upserted: 1,
      skipped: 1,
      collapsed: 0,
      classifiedOut: 0,
    });
  });

  it("is a no-op for an empty outcode set (provider not called)", async () => {
    const h = makeHarness({ agents: [] });
    const result = await h.service.discoverByOutcodes([]);
    expect(h.discover).not.toHaveBeenCalled();
    expect(result).toEqual({
      discovered: 0,
      upserted: 0,
      skipped: 0,
      collapsed: 0,
      classifiedOut: 0,
    });
  });

  it("is a no-op when every outcode is blank (provider not called)", async () => {
    const h = makeHarness({ agents: [] });
    const result = await h.service.discoverByOutcodes(["", "   "]);
    expect(h.discover).not.toHaveBeenCalled();
    expect(result).toEqual({
      discovered: 0,
      upserted: 0,
      skipped: 0,
      collapsed: 0,
      classifiedOut: 0,
    });
  });
});

describe("pickBestEmail", () => {
  it("prefers a local-part matching the search location", () => {
    expect(
      pickBestEmail(
        ["lettings@fp.com", "conwy@fp.com", "rhos@fp.com"],
        "Conwy County",
      ),
    ).toBe("conwy@fp.com");
  });

  it("prefers a generic agency inbox when nothing matches the location", () => {
    expect(
      pickBestEmail(["jane.doe@fp.com", "info@fp.com", "sales@fp.com"], "Bath"),
    ).toBe("info@fp.com");
  });

  it("falls back to the shortest local-part, then first-seen on a full tie", () => {
    expect(pickBestEmail(["alexander@fp.com", "amy@fp.com"], "Bath")).toBe(
      "amy@fp.com",
    );
    expect(pickBestEmail(["bob@fp.com", "ann@fp.com"], "Bath")).toBe("bob@fp.com");
  });
});

describe("AgentDiscoveryService per-domain collapse", () => {
  it("collapses several mailboxes at one agency to a single best contact", async () => {
    const h = makeHarness({
      agents: [
        { email: "lettings@fletcherpoole.com", agencyName: "Fletcher & Poole" },
        { email: "conwy@fletcherpoole.com", agencyName: "Fletcher & Poole" },
        { email: "rhos@fletcherpoole.com", agencyName: "Fletcher & Poole" },
      ],
    });
    const result = await h.service.discoverRegion("Conwy County");
    // One agency = one upsert; the location-matching mailbox wins.
    expect(h.upsertByEmail).toHaveBeenCalledTimes(1);
    expect(h.upsertByEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "conwy@fletcherpoole.com" }),
    );
    expect(result).toEqual({
      discovered: 3,
      upserted: 1,
      skipped: 0,
      collapsed: 2,
      classifiedOut: 0,
    });
  });

  it("keeps distinct agencies separate (different domains are not collapsed)", async () => {
    const h = makeHarness({
      agents: [
        { email: "info@agency-a.co.uk", agencyName: "A" },
        { email: "info@agency-b.co.uk", agencyName: "B" },
      ],
    });
    const result = await h.service.discoverRegion("Conwy County");
    expect(h.upsertByEmail).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      discovered: 2,
      upserted: 2,
      skipped: 0,
      collapsed: 0,
      classifiedOut: 0,
    });
  });

  it("drops free-mail addresses entirely (never persisted)", async () => {
    const h = makeHarness({
      agents: [
        { email: "jane@gmail.com", agencyName: "Jane (sole trader)" },
        { email: "john@gmail.com", agencyName: "John (sole trader)" },
      ],
    });
    const result = await h.service.discoverRegion("Conwy County");
    // gmail is free-mail → not a corporate subscriber → dropped at discovery.
    expect(h.upsertByEmail).not.toHaveBeenCalled();
    expect(result).toEqual({
      discovered: 2,
      upserted: 0,
      skipped: 2,
      collapsed: 0,
      classifiedOut: 0,
    });
  });
});

describe("AgentDiscoveryService quality classify gate", () => {
  it("does NOT upsert a confident non-agency verdict (counted classifiedOut)", async () => {
    const h = makeHarness({
      agents: [
        { email: "info@conwy-estates.co.uk", agencyName: "Conwy Estates" },
        { email: "info@some-portal.co.uk", agencyName: "Some Portal" },
      ],
      classifyBy: (email) =>
        email === "info@some-portal.co.uk"
          ? confidentJunkVerdict("portal")
          : keepVerdict(),
    });
    const result = await h.service.discoverRegion("Conwy County");

    // The confident non-agency candidate is dropped before upsert; the genuine
    // agency is kept. Both survived the deterministic filters, so both were
    // classified by the LLM.
    expect(h.classify).toHaveBeenCalledTimes(2);
    expect(h.upsertByEmail).toHaveBeenCalledTimes(1);
    expect(h.upsertByEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "info@conwy-estates.co.uk" }),
    );
    expect(h.upsertByEmail).not.toHaveBeenCalledWith(
      expect.objectContaining({ email: "info@some-portal.co.uk" }),
    );
    expect(result).toEqual({
      discovered: 2,
      upserted: 1,
      skipped: 0,
      collapsed: 0,
      classifiedOut: 1,
    });
  });

  it("KEEPS an uncertain non-agency verdict (below the auto-delete threshold)", async () => {
    const h = makeHarness({
      agents: [{ email: "info@maybe-agency.co.uk", agencyName: "Maybe Agency" }],
      classifyBy: () => uncertainJunkVerdict(),
    });
    const result = await h.service.discoverRegion("Conwy County");

    // Uncertain → KEPT (never silently delete a real agent on a shaky call).
    expect(h.upsertByEmail).toHaveBeenCalledTimes(1);
    expect(h.upsertByEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "info@maybe-agency.co.uk" }),
    );
    expect(result).toEqual({
      discovered: 1,
      upserted: 1,
      skipped: 0,
      collapsed: 0,
      classifiedOut: 0,
    });
  });

  it("KEEPS a genuine agency verdict (upserted)", async () => {
    const h = makeHarness({
      agents: [{ email: "info@real-agency.co.uk", agencyName: "Real Agency" }],
      classifyBy: () => keepVerdict(),
    });
    const result = await h.service.discoverRegion("Conwy County");

    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.upsertByEmail).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      discovered: 1,
      upserted: 1,
      skipped: 0,
      collapsed: 0,
      classifiedOut: 0,
    });
  });

  it("drops a property-portal email deterministically WITHOUT calling classify", async () => {
    const h = makeHarness({
      agents: [
        { email: "info@conwy-estates.co.uk", agencyName: "Conwy Estates" },
        { email: "noreply@rightmove.co.uk", agencyName: "Rightmove" },
      ],
      classifyBy: () => keepVerdict(),
    });
    const result = await h.service.discoverRegion("Conwy County");

    // The portal email is dropped by the deterministic isPortalEmail filter —
    // never reaching (or paying for) the LLM. The genuine agency IS classified.
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.classify).not.toHaveBeenCalledWith(
      expect.objectContaining({ email: "noreply@rightmove.co.uk" }),
    );
    expect(h.upsertByEmail).toHaveBeenCalledTimes(1);
    expect(h.upsertByEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "info@conwy-estates.co.uk" }),
    );
    expect(result).toEqual({
      discovered: 2,
      upserted: 1,
      skipped: 0,
      collapsed: 0,
      classifiedOut: 1,
    });
  });

  it("drops a housing-association name deterministically WITHOUT calling classify", async () => {
    const h = makeHarness({
      agents: [
        {
          email: "post@grwpcynefin.org",
          agencyName: "Grwp Cynefin Housing Association",
        },
      ],
      classifyBy: () => keepVerdict(),
    });
    const result = await h.service.discoverRegion("Conwy County");

    // The stored name carries the "housing association" token → isNonAgencyName
    // drops it deterministically, no LLM call.
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.upsertByEmail).not.toHaveBeenCalled();
    expect(result).toEqual({
      discovered: 1,
      upserted: 0,
      skipped: 0,
      collapsed: 0,
      classifiedOut: 1,
    });
  });

  it("does NOT call the classifier when the kill-switch is on (everything kept)", async () => {
    process.env.ANALYSIS_KILL_SWITCH = "1";
    const h = makeHarness({
      agents: [
        { email: "info@a.co.uk", agencyName: "A" },
        { email: "info@b.co.uk", agencyName: "B" },
      ],
      // A confident-junk verdict for everything — proving the gate is short-
      // circuited (it would otherwise delete both).
      classifyBy: () => confidentJunkVerdict("portal"),
    });
    const result = await h.service.discoverRegion("Conwy County");

    expect(h.classify).not.toHaveBeenCalled();
    expect(h.upsertByEmail).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      discovered: 2,
      upserted: 2,
      skipped: 0,
      collapsed: 0,
      classifiedOut: 0,
    });
  });

  it("KEEPS everything when no classifier is wired (gate is a no-op)", async () => {
    // No classifyBy → the harness wires NO classifier; the gate must KEEP all.
    const h = makeHarness({
      agents: [{ email: "info@a.co.uk", agencyName: "A" }],
    });
    const result = await h.service.discoverRegion("Conwy County");

    expect(h.classify).not.toHaveBeenCalled();
    expect(h.upsertByEmail).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      discovered: 1,
      upserted: 1,
      skipped: 0,
      collapsed: 0,
      classifiedOut: 0,
    });
  });
});

describe("getAgentDiscoveryService", () => {
  afterEach(() => _setAgentDiscoveryServiceForTesting(null));
  it("throws before initialisation", () => {
    _setAgentDiscoveryServiceForTesting(null);
    expect(() => getAgentDiscoveryService()).toThrow(/not initialised/);
  });
  it("returns the same instance after init", () => {
    const provider = {
      discover: vi.fn(),
    } as unknown as AgentDiscoveryProvider;
    const first = getAgentDiscoveryService({ provider });
    expect(getAgentDiscoveryService()).toBe(first);
  });
});
