/**
 * discover:agents consumer (M7) — runs region agent discovery + upsert. The
 * campaign (M8) / an operator enqueues a { regionName }; this delegates to the
 * AgentDiscoveryService. Discovery errors (transient search/scrape failures) are
 * retryable via the shared worker-error mapper. Discovery only SOURCES — the
 * ComplianceGuard still gates every subsequent send (corporate-only).
 */
import type { DiscoverAgentsJobPayload } from "@homescout/backend-core/lib/queue/queue-config";
import type { AgentDiscoveryService } from "@homescout/backend-core/services/agent-discovery.service";
import { toWorkerError } from "./worker-error.js";

export interface DiscoverAgentsHandlerDeps {
  agentDiscoveryService: AgentDiscoveryService;
}

export function makeDiscoverAgentsHandler(deps: DiscoverAgentsHandlerDeps) {
  return async function handleDiscoverAgents(job: {
    data: DiscoverAgentsJobPayload;
  }): Promise<void> {
    try {
      await deps.agentDiscoveryService.discoverRegion(job.data.regionName);
    } catch (error) {
      throw toWorkerError(error, {
        scope: "discover.agents.failed",
        region: job.data.regionName,
      });
    }
  };
}
