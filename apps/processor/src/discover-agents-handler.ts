/**
 * discover:agents consumer (M7 + PR3) — runs agent discovery + upsert. Two
 * targeting modes, branched on the payload:
 *   - { outcodes } (PR3 search launch): discover by an EXPLICIT outcode set.
 *   - { regionName } (M7): discover by a curated region name (resolved server-side).
 * Delegates to the AgentDiscoveryService. Discovery errors (transient
 * search/scrape failures) are retryable via the shared worker-error mapper.
 * Discovery only SOURCES — the ComplianceGuard still gates every subsequent send
 * (corporate-only).
 */
import type { DiscoverAgentsJobPayload } from "@homeranger/backend-core/lib/queue/queue-config";
import type { AgentDiscoveryService } from "@homeranger/backend-core/services/agent-discovery.service";
import { toWorkerError } from "./worker-error.js";

export interface DiscoverAgentsHandlerDeps {
  agentDiscoveryService: AgentDiscoveryService;
}

export function makeDiscoverAgentsHandler(deps: DiscoverAgentsHandlerDeps) {
  return async function handleDiscoverAgents(job: {
    data: DiscoverAgentsJobPayload;
  }): Promise<void> {
    const { outcodes, regionName } = job.data;
    try {
      if (outcodes && outcodes.length > 0) {
        await deps.agentDiscoveryService.discoverByOutcodes(outcodes, regionName);
      } else {
        await deps.agentDiscoveryService.discoverRegion(regionName ?? "");
      }
    } catch (error) {
      throw toWorkerError(error, {
        scope: "discover.agents.failed",
        ...(outcodes && outcodes.length > 0
          ? { outcodes }
          : { region: regionName }),
      });
    }
  };
}
