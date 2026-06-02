/**
 * Cloudflare AI Gateway wiring for homescout's outbound LLM calls.
 *
 * AI Gateway is a TRANSPARENT PROXY in front of the model provider (Anthropic
 * today; Voyage / Haiku join in M5): the app keeps its OWN provider API key and
 * only changes the SDK `baseURL` to the gateway, gaining request/token/cost
 * analytics, response caching, automatic retries, and a queryable request log —
 * without changing the model, the prompt, or the call sites. The gateway itself
 * is provisioned in infra/terraform/cloudflare/ai-gateway.tf; rationale +
 * residency call live in docs/decisions/2026-06-02-ai-gateway.md.
 *
 * Activation is purely env-driven and OPTIONAL. With the `CF_AI_GATEWAY_*` env
 * unset the helpers return EMPTY options and the SDK talks to the provider
 * directly — the local-dev, unit-test, and CI path (where `EXTRACTION_FAKE=1`
 * short-circuits the LLM entirely). This keeps the integration reversible:
 * unsetting the env reverts to direct calls with zero code change, honouring the
 * swappable-provider rule the email/embedding decisions established.
 *
 * Residency note: when enabled, prompts/responses transit Cloudflare's edge and
 * logs are stored on Cloudflare. This is consistent with the already-waived
 * US-Anthropic residency posture (see docs/decisions/2026-06-01-email-provider-
 * vendor.md) and does not widen it to any NEW data class.
 */

/** Root of the AI Gateway proxy. The provider slug + native path are appended. */
const GATEWAY_HOST = "https://gateway.ai.cloudflare.com";

export interface AiGatewayConfig {
  /** Cloudflare account id — the 32-char hex account tag in the gateway URL. */
  accountId: string;
  /** Gateway slug/name (e.g. "homescout"), as created in ai-gateway.tf. */
  gatewayId: string;
  /**
   * Optional `cf-aig-authorization` bearer for AUTHENTICATED gateways. Absent
   * for the default unauthenticated gateway; present flips the auth header on
   * (no code change — just set CF_AI_GATEWAY_TOKEN and authentication=true in TF).
   */
  token?: string;
}

/** Read an env var, treating undefined / blank / whitespace-only as absent. */
function cleanEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read the gateway config from env. Returns `null` unless BOTH the account id
 * and the gateway id are present — a half-configured gateway (only one of the
 * two) is treated as "off" rather than producing a malformed proxy URL.
 */
export function getAiGatewayConfig(): AiGatewayConfig | null {
  const accountId = cleanEnv("CF_AI_GATEWAY_ACCOUNT_ID");
  const gatewayId = cleanEnv("CF_AI_GATEWAY_ID");
  if (!accountId || !gatewayId) {
    return null;
  }
  const token = cleanEnv("CF_AI_GATEWAY_TOKEN");
  return token ? { accountId, gatewayId, token } : { accountId, gatewayId };
}

/** The provider-scoped gateway base URL the SDK appends its native path onto. */
export function gatewayBaseUrl(
  provider: string,
  config: AiGatewayConfig,
): string {
  return `${GATEWAY_HOST}/v1/${config.accountId}/${config.gatewayId}/${provider}`;
}

export interface GatewayClientOptions {
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
}

/**
 * Options to spread into `new Anthropic({...})`. Returns an EMPTY object when
 * the gateway is unconfigured (direct-to-Anthropic). The Anthropic SDK appends
 * `/v1/messages` to `baseURL`, so the gateway receives `.../anthropic/v1/messages`
 * — exactly the path the AI Gateway Anthropic provider expects.
 */
export function anthropicGatewayClientOptions(
  config: AiGatewayConfig | null = getAiGatewayConfig(),
): GatewayClientOptions {
  if (!config) {
    return {};
  }
  const options: GatewayClientOptions = {
    baseURL: gatewayBaseUrl("anthropic", config),
  };
  if (config.token) {
    options.defaultHeaders = {
      "cf-aig-authorization": `Bearer ${config.token}`,
    };
  }
  return options;
}
