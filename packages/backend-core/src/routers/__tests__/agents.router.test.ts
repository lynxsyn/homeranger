/**
 * agentsRouter unit tests (PR1). Pure unit: real `new XRepository()` instances
 * are injected via each repo's own `_setXRepositoryForTesting` seam (the router
 * reads the live `agentRepository` / `outreachRepository` / `listingRepository`
 * singletons as ESM live bindings), then spied with `vi.spyOn` on the exact
 * methods the router calls (`list` / `latestStatusByAgentIds` /
 * `countByAgentEmails`). Procedures are invoked through
 * `appRouter.createCaller({ user })`. No DB.
 *
 * Asserts:
 *   - status mapping: replied / awaiting / queued (active) / queued (no thread)
 *     / opted_out (incl. optedOut PRECEDENCE over an open thread).
 *   - homesCount join by email (missing email → 0).
 *   - stats aggregation: contacted (lastContactedAt != null), replied,
 *     awaiting (queued FOLDS IN), homesIngested (sum).
 *   - outcode scope passes through to agentRepository.list.
 *   - operatorProcedure: anon → UNAUTHORIZED, non-operator → FORBIDDEN.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { Prisma, type OutreachThreadStatus } from "@prisma/client";
import { appRouter } from "../index.js";
import {
  AgentRepository,
  _setAgentRepositoryForTesting,
  type AgentRecord,
} from "../../repositories/agent.repository.js";
import {
  OutreachRepository,
  _setOutreachRepositoryForTesting,
} from "../../repositories/outreach.repository.js";
import {
  ListingRepository,
  _setListingRepositoryForTesting,
} from "../../repositories/listing.repository.js";

let agentIdCounter = 0;
function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  agentIdCounter += 1;
  const suffix = agentIdCounter.toString(16).padStart(2, "0");
  return {
    id: `00000000-0000-7000-8000-0000000000${suffix}`,
    email: `info@agency-${suffix}.co.uk`,
    agencyName: `Agency ${suffix}`,
    mailboxType: "corporate_subscriber",
    optedOut: false,
    coveredOutcodes: ["LL30"],
    lastContactedAt: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as AgentRecord;
}

// dev@homeranger.local is the default operator → ownerKeyFor resolves to null,
// so operatorProcedure admits this caller.
const operatorCaller = appRouter.createCaller({
  user: {
    id: "00000000-0000-0000-0000-0000000000de",
    email: "dev@homeranger.local",
  },
});

// A non-operator signed-in user → operatorProcedure must FORBID.
const partnerCaller = appRouter.createCaller({
  user: {
    id: "33333333-3333-4333-8333-333333333333",
    email: "partner@homeranger.test",
  },
});

/**
 * Wire up all three repos with `vi.spyOn` on the methods the router calls.
 * Returns the spies so a test can assert call args (e.g. the outcode scope).
 */
function injectRepos(opts: {
  agents: AgentRecord[];
  statusByAgentId?: Map<string, OutreachThreadStatus>;
  homesByEmail?: Map<string, number>;
}) {
  const agentRepo = new AgentRepository();
  const listSpy = vi
    .spyOn(agentRepo, "list")
    .mockResolvedValue({ items: opts.agents, nextCursor: null });
  _setAgentRepositoryForTesting(agentRepo);

  const outreachRepo = new OutreachRepository();
  const statusSpy = vi
    .spyOn(outreachRepo, "latestStatusByAgentIds")
    .mockResolvedValue(opts.statusByAgentId ?? new Map());
  _setOutreachRepositoryForTesting(outreachRepo);

  const listingRepo = new ListingRepository();
  const homesSpy = vi
    .spyOn(listingRepo, "countByAgentEmails")
    .mockResolvedValue(opts.homesByEmail ?? new Map());
  _setListingRepositoryForTesting(listingRepo);

  return { listSpy, statusSpy, homesSpy };
}

afterEach(() => {
  _setAgentRepositoryForTesting(null);
  _setOutreachRepositoryForTesting(null);
  _setListingRepositoryForTesting(null);
  vi.restoreAllMocks();
});

describe("agentsRouter.list status mapping", () => {
  it("derives replied / awaiting / queued(active) / queued(no-thread) from the latest open thread", async () => {
    const replied = makeAgent();
    const awaiting = makeAgent();
    const active = makeAgent();
    const noThread = makeAgent();
    injectRepos({
      agents: [replied, awaiting, active, noThread],
      statusByAgentId: new Map<string, OutreachThreadStatus>([
        [replied.id, "replied"],
        [awaiting.id, "awaiting_reply"],
        [active.id, "active"],
        // noThread is intentionally ABSENT from the Map.
      ]),
    });

    const rows = await operatorCaller.agents.list({});
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(replied.id)).toBe("replied");
    expect(byId.get(awaiting.id)).toBe("awaiting");
    expect(byId.get(active.id)).toBe("queued");
    expect(byId.get(noThread.id)).toBe("queued");
  });

  it("opted_out takes PRECEDENCE over an open thread status", async () => {
    // An opted-out agent could still carry a non-closed thread row in the Map;
    // optedOut is checked FIRST, so it must win regardless.
    const optedOut = makeAgent({ optedOut: true });
    injectRepos({
      agents: [optedOut],
      statusByAgentId: new Map<string, OutreachThreadStatus>([
        [optedOut.id, "replied"],
      ]),
    });

    const [row] = await operatorCaller.agents.list({});
    expect(row!.status).toBe("opted_out");
  });
});

describe("agentsRouter.list homesCount join", () => {
  it("joins the per-email homes count and defaults a missing email to 0", async () => {
    const seller = makeAgent({ email: "info@seller.co.uk" });
    const quiet = makeAgent({ email: "info@quiet.co.uk" });
    injectRepos({
      agents: [seller, quiet],
      homesByEmail: new Map([["info@seller.co.uk", 4]]),
    });

    const rows = await operatorCaller.agents.list({});
    const byId = new Map(rows.map((r) => [r.id, r.homesCount]));
    expect(byId.get(seller.id)).toBe(4);
    expect(byId.get(quiet.id)).toBe(0);
  });

  it("returns the contract field shape (outcodes from coveredOutcodes, Date passthrough)", async () => {
    const contactedAt = new Date("2026-05-01T09:00:00.000Z");
    const agent = makeAgent({
      agencyName: "Conwy Estates",
      email: "info@conwy.co.uk",
      coveredOutcodes: ["LL30", "LL31"],
      lastContactedAt: contactedAt,
    });
    injectRepos({ agents: [agent] });

    const [row] = await operatorCaller.agents.list({});
    // Stable fields are matched exactly; `coverage` is data-derived (bundled UK
    // index) so it is asserted by shape, not pinned to every town string.
    const { coverage, ...rest } = row!;
    expect(rest).toEqual({
      id: agent.id,
      agencyName: "Conwy Estates",
      email: "info@conwy.co.uk",
      outcodes: ["LL30", "LL31"],
      status: "queued",
      homesCount: 0,
      lastContactedAt: contactedAt,
    });
    // LL30/LL31 both resolve to the Conwy principal area via the bundled index;
    // HQ = the first outcode.
    expect(coverage).toMatchObject({
      count: 2,
      region: "Conwy",
      regions: ["Conwy"],
      primary: "LL30",
    });
  });
});

describe("agentsRouter.list scope + repo wiring", () => {
  it("pages the outcode scope through agentRepository.list (opted-out INCLUDED, 100/page)", async () => {
    const { listSpy, statusSpy, homesSpy } = injectRepos({
      agents: [makeAgent({ id: "00000000-0000-7000-8000-0000000000c1" })],
    });

    await operatorCaller.agents.list({ outcodes: ["SW1A", "SE1"] });

    expect(listSpy).toHaveBeenCalledWith({
      outcodes: ["SW1A", "SE1"],
      includeOptedOut: true,
      limit: 100,
    });
    // The enrichment joins are keyed by the SAME agents the list returned.
    expect(statusSpy).toHaveBeenCalledWith([
      "00000000-0000-7000-8000-0000000000c1",
    ]);
    expect(homesSpy).toHaveBeenCalledTimes(1);
  });

  it("passes undefined outcodes through when the scope is absent (all agents)", async () => {
    const { listSpy } = injectRepos({ agents: [] });
    await operatorCaller.agents.list({});
    expect(listSpy).toHaveBeenCalledWith({
      outcodes: undefined,
      includeOptedOut: true,
      limit: 100,
    });
  });
});

describe("agentsRouter.stats aggregation", () => {
  it("aggregates contacted / replied / awaiting(queued folds in) / homesIngested over the rows", async () => {
    const repliedContacted = makeAgent({
      email: "a@x.co.uk",
      lastContactedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const awaitingContacted = makeAgent({
      email: "b@x.co.uk",
      lastContactedAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    const queuedUncontacted = makeAgent({ email: "c@x.co.uk" });
    const optedOutContacted = makeAgent({
      email: "d@x.co.uk",
      optedOut: true,
      lastContactedAt: new Date("2026-04-03T00:00:00.000Z"),
    });
    injectRepos({
      agents: [
        repliedContacted,
        awaitingContacted,
        queuedUncontacted,
        optedOutContacted,
      ],
      statusByAgentId: new Map<string, OutreachThreadStatus>([
        [repliedContacted.id, "replied"],
        [awaitingContacted.id, "awaiting_reply"],
        [queuedUncontacted.id, "active"],
      ]),
      homesByEmail: new Map([
        ["a@x.co.uk", 3],
        ["b@x.co.uk", 2],
        ["d@x.co.uk", 5],
      ]),
    });

    const stats = await operatorCaller.agents.stats({});
    expect(stats).toEqual({
      // a, b, d carry lastContactedAt; c does not.
      contacted: 3,
      // only a is "replied".
      replied: 1,
      // b is "awaiting" + c is "queued" → both fold into awaiting; d is opted_out.
      awaiting: 2,
      // 3 + 2 + 0 + 5.
      homesIngested: 10,
    });
  });

  it("passes the outcode scope through to the row build (list + stats stay consistent)", async () => {
    const { listSpy } = injectRepos({ agents: [] });
    await operatorCaller.agents.stats({ outcodes: ["LL30"] });
    expect(listSpy).toHaveBeenCalledWith({
      outcodes: ["LL30"],
      includeOptedOut: true,
      limit: 100,
    });
  });
});

describe("agentsRouter.remove", () => {
  const AGENT_ID = "00000000-0000-7000-8000-0000000000a9";

  /** Inject just an AgentRepository spy on deleteById (the only call remove makes). */
  function injectDeleteSpy(impl: () => Promise<void>) {
    const agentRepo = new AgentRepository();
    const spy = vi.spyOn(agentRepo, "deleteById").mockImplementation(impl);
    _setAgentRepositoryForTesting(agentRepo);
    return spy;
  }

  it("completely removes an agent and echoes { id }", async () => {
    const spy = injectDeleteSpy(async () => undefined);
    const result = await operatorCaller.agents.remove({ id: AGENT_ID });
    expect(result).toEqual({ id: AGENT_ID });
    expect(spy).toHaveBeenCalledWith(AGENT_ID);
  });

  it("maps Prisma P2025 (missing agent) to NOT_FOUND", async () => {
    injectDeleteSpy(async () => {
      throw new Prisma.PrismaClientKnownRequestError("not found", {
        code: "P2025",
        clientVersion: Prisma.prismaVersion.client,
      });
    });
    await expect(
      operatorCaller.agents.remove({ id: AGENT_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("FORBIDS a non-operator and rejects anon with UNAUTHORIZED", async () => {
    await expect(
      partnerCaller.agents.remove({ id: AGENT_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const anon = appRouter.createCaller({ user: null });
    await expect(
      anon.agents.remove({ id: AGENT_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("agentsRouter auth", () => {
  it("rejects an anonymous caller with UNAUTHORIZED", async () => {
    const anon = appRouter.createCaller({ user: null });
    await expect(anon.agents.list({})).rejects.toBeInstanceOf(TRPCError);
    await expect(anon.agents.list({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(anon.agents.stats({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("FORBIDS a non-operator (agents are operator-only)", async () => {
    await expect(partnerCaller.agents.list({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(partnerCaller.agents.stats({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
