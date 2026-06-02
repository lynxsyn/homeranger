import { describe, expect, it, vi } from "vitest";
import { makeDiscoverAgentsHandler } from "./discover-agents-handler.js";
import type { AgentDiscoveryService } from "@homescout/backend-core/services/agent-discovery.service";

describe("makeDiscoverAgentsHandler", () => {
  it("delegates the region to AgentDiscoveryService.discoverRegion", async () => {
    const discoverRegion = vi
      .fn()
      .mockResolvedValue({ discovered: 2, upserted: 2, skipped: 0 });
    const handler = makeDiscoverAgentsHandler({
      agentDiscoveryService: { discoverRegion } as unknown as AgentDiscoveryService,
    });
    await handler({ data: { regionName: "Conwy County" } });
    expect(discoverRegion).toHaveBeenCalledWith("Conwy County");
  });

  it("branches to discoverByOutcodes when the payload carries outcodes", async () => {
    const discoverRegion = vi.fn();
    const discoverByOutcodes = vi
      .fn()
      .mockResolvedValue({ discovered: 1, upserted: 1, skipped: 0 });
    const handler = makeDiscoverAgentsHandler({
      agentDiscoveryService: {
        discoverRegion,
        discoverByOutcodes,
      } as unknown as AgentDiscoveryService,
    });
    await handler({ data: { outcodes: ["LL30", "LL31"] } });
    expect(discoverByOutcodes).toHaveBeenCalledWith(["LL30", "LL31"]);
    expect(discoverRegion).not.toHaveBeenCalled();
  });

  it("prefers outcodes over regionName when both are present", async () => {
    const discoverRegion = vi.fn();
    const discoverByOutcodes = vi
      .fn()
      .mockResolvedValue({ discovered: 0, upserted: 0, skipped: 0 });
    const handler = makeDiscoverAgentsHandler({
      agentDiscoveryService: {
        discoverRegion,
        discoverByOutcodes,
      } as unknown as AgentDiscoveryService,
    });
    await handler({ data: { regionName: "Conwy County", outcodes: ["LL30"] } });
    expect(discoverByOutcodes).toHaveBeenCalledWith(["LL30"]);
    expect(discoverRegion).not.toHaveBeenCalled();
  });

  it("falls back to discoverRegion when outcodes is an empty array", async () => {
    const discoverRegion = vi
      .fn()
      .mockResolvedValue({ discovered: 0, upserted: 0, skipped: 0 });
    const handler = makeDiscoverAgentsHandler({
      agentDiscoveryService: {
        discoverRegion,
        discoverByOutcodes: vi.fn(),
      } as unknown as AgentDiscoveryService,
    });
    await handler({ data: { regionName: "Conwy County", outcodes: [] } });
    expect(discoverRegion).toHaveBeenCalledWith("Conwy County");
  });

  it("rethrows a transient discovery error (retryable)", async () => {
    const boom = Object.assign(new Error("Firecrawl 429"), { retryable: true });
    const handler = makeDiscoverAgentsHandler({
      agentDiscoveryService: {
        discoverRegion: vi.fn().mockRejectedValue(boom),
      } as unknown as AgentDiscoveryService,
    });
    await expect(
      handler({ data: { regionName: "Conwy County" } }),
    ).rejects.toBe(boom);
  });
});
