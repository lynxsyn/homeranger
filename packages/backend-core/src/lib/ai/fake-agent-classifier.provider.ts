/**
 * Env-gated FAKE agent classifier (`ANALYSIS_FAKE=1` / `CLASSIFY_FAKE=1`).
 * DETERMINISTIC, network-free, zero spend — selected in the worker under the
 * ANALYSIS_FAKE umbrella so unit/integration/E2E never call Anthropic. Never in
 * prod.
 *
 * KEEP-BIASED by design: any normal/business domain (including the
 * FakeAgentDiscoveryProvider's `.example` agents) returns
 * `isResidentialSalesAgency:true, confidence:1` so the existing discovery
 * integration tests that expect those upserted keep passing. A small hardcoded
 * JUNK fixture set (a property portal, a housing association, a `.gov.uk`
 * council host) returns a CONFIDENT junk verdict (`confidence:0.95`) so the
 * service/integration tests can assert the auto-delete path without Anthropic.
 */
import type {
  AgentClassifier,
  AgentClassifyInput,
  AgentClassifyResult,
  AgentKind,
} from "./agent-classifier.provider.js";

/** Deterministic confident-junk fixtures, keyed on the email domain. */
const JUNK_DOMAINS: ReadonlyMap<string, AgentKind> = new Map([
  ["onthemarket.com", "portal"],
  ["wwha.co.uk", "housing_association"],
]);

function junkKindFor(email: string): AgentKind | undefined {
  const at = email.lastIndexOf("@");
  if (at <= 0) {
    return undefined;
  }
  const domain = email.slice(at + 1).toLowerCase();
  const direct = JUNK_DOMAINS.get(domain);
  if (direct) {
    return direct;
  }
  // A .gov.uk host is a council (a wrong cold-target).
  if (domain === "gov.uk" || domain.endsWith(".gov.uk")) {
    return "council";
  }
  return undefined;
}

export class FakeAgentClassifier implements AgentClassifier {
  private readonly model = "fake-haiku";

  getModel(): string {
    return this.model;
  }

  async classify(input: AgentClassifyInput): Promise<AgentClassifyResult> {
    const junkKind = junkKindFor(input.email);
    const isJunk = junkKind !== undefined;
    return {
      isResidentialSalesAgency: !isJunk,
      kind: isJunk ? junkKind : "estate_agent",
      confidence: isJunk ? 0.95 : 1,
      suggestedName: input.agencyName ?? "",
      metrics: {
        model: this.model,
        inputTokens: 0,
        outputTokens: 0,
        costPence: 0,
        durationMs: 0,
      },
    };
  }
}
