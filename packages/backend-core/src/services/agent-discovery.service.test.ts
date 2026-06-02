import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultAgentDiscoveryService,
  classifyMailboxType,
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
    expect(result).toEqual({ discovered: 2, upserted: 2, skipped: 0 });
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
    expect(result).toEqual({ discovered: 2, upserted: 1, skipped: 1 });
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
    expect(result).toEqual({ discovered: 2, upserted: 1, skipped: 1 });
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
    expect(result).toEqual({ discovered: 2, upserted: 1, skipped: 1 });
  });

  it("is a no-op for an unsupported region (provider not called)", async () => {
    const h = makeHarness({ agents: [] });
    const result = await h.service.discoverRegion("Atlantis");
    expect(h.discover).not.toHaveBeenCalled();
    expect(result).toEqual({ discovered: 0, upserted: 0, skipped: 0 });
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
