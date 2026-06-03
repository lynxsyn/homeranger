import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultAgentDiscoveryService,
  classifyMailboxType,
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

interface Harness {
  service: DefaultAgentDiscoveryService;
  discover: ReturnType<typeof vi.fn>;
  upsertByEmail: ReturnType<typeof vi.fn>;
  isSuppressed: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: {
  agents: DiscoveredAgent[];
  suppressed?: string[];
}): Harness {
  const discover = vi.fn().mockResolvedValue(opts.agents);
  const upsertByEmail = vi.fn().mockResolvedValue({});
  const suppressedSet = new Set(opts.suppressed ?? []);
  const isSuppressed = vi.fn(async (email: string) => suppressedSet.has(email));

  const service = new DefaultAgentDiscoveryService({
    provider: { discover } as unknown as AgentDiscoveryProvider,
    agentRepository: { upsertByEmail } as unknown as AgentRepository,
    suppressionEntryRepository: {
      isSuppressed,
    } as unknown as SuppressionEntryRepository,
  });
  return { service, discover, upsertByEmail, isSuppressed };
}

afterEach(() => vi.restoreAllMocks());

describe("AgentDiscoveryService.discoverRegion", () => {
  it("discovers, classifies, and upserts agents with the region's outcodes", async () => {
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
    // Business domain → corporate_subscriber, with the region outcodes.
    expect(h.upsertByEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "info@conwy-estates.co.uk",
        mailboxType: "corporate_subscriber",
        coveredOutcodes: expect.arrayContaining(["LL32"]),
      }),
    );
    // Free webmail → individual (sourced, but the guard will block sends to it).
    expect(h.upsertByEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "joe@gmail.com", mailboxType: "individual" }),
    );
    expect(result).toEqual({ discovered: 2, upserted: 2, skipped: 0, collapsed: 0 });
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
    expect(result).toEqual({ discovered: 2, upserted: 1, skipped: 1, collapsed: 0 });
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
    expect(result).toEqual({ discovered: 2, upserted: 1, skipped: 1, collapsed: 0 });
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
    expect(result).toEqual({ discovered: 2, upserted: 1, skipped: 1, collapsed: 0 });
  });

  it("is a no-op for an unsupported region (provider not called)", async () => {
    const h = makeHarness({ agents: [] });
    const result = await h.service.discoverRegion("Atlantis");
    expect(h.discover).not.toHaveBeenCalled();
    expect(result).toEqual({ discovered: 0, upserted: 0, skipped: 0, collapsed: 0 });
  });
});

describe("AgentDiscoveryService.discoverByOutcodes", () => {
  it("discovers + upserts over an EXPLICIT outcode set (no region resolution)", async () => {
    const h = makeHarness({
      agents: [
        { email: "info@conwy-estates.co.uk", agencyName: "Conwy Estates" },
        { email: "joe@gmail.com", agencyName: "Joe (sole trader)" },
      ],
    });
    const result = await h.service.discoverByOutcodes(["LL30", "LL31"]);

    // The provider gets the explicit outcodes verbatim (no regionToOutcodes).
    expect(h.discover).toHaveBeenCalledWith(
      expect.objectContaining({ outcodes: ["LL30", "LL31"] }),
    );
    // Upserts stamp the SAME explicit outcodes on the agent.
    expect(h.upsertByEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "info@conwy-estates.co.uk",
        mailboxType: "corporate_subscriber",
        coveredOutcodes: ["LL30", "LL31"],
      }),
    );
    expect(result).toEqual({ discovered: 2, upserted: 2, skipped: 0, collapsed: 0 });
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
    expect(result).toEqual({ discovered: 2, upserted: 1, skipped: 1, collapsed: 0 });
  });

  it("is a no-op for an empty outcode set (provider not called)", async () => {
    const h = makeHarness({ agents: [] });
    const result = await h.service.discoverByOutcodes([]);
    expect(h.discover).not.toHaveBeenCalled();
    expect(result).toEqual({ discovered: 0, upserted: 0, skipped: 0, collapsed: 0 });
  });

  it("is a no-op when every outcode is blank (provider not called)", async () => {
    const h = makeHarness({ agents: [] });
    const result = await h.service.discoverByOutcodes(["", "   "]);
    expect(h.discover).not.toHaveBeenCalled();
    expect(result).toEqual({ discovered: 0, upserted: 0, skipped: 0, collapsed: 0 });
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
    });
  });

  it("never collapses free-mail individuals (each is a distinct person)", async () => {
    const h = makeHarness({
      agents: [
        { email: "jane@gmail.com", agencyName: "Jane (sole trader)" },
        { email: "john@gmail.com", agencyName: "John (sole trader)" },
      ],
    });
    const result = await h.service.discoverRegion("Conwy County");
    // gmail.com is not "one agency" — both kept (the guard blocks the sends).
    expect(h.upsertByEmail).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      discovered: 2,
      upserted: 2,
      skipped: 0,
      collapsed: 0,
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
