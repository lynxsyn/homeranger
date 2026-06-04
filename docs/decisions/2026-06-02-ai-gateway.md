---
decision_id: 2026-06-02-ai-gateway
status: accepted
date: 2026-06-02
gate: platform-scope (Cloudflare adoption)
supersedes: none
---

# Decision: Adopt Cloudflare AI Gateway as a transparent proxy for outbound LLM calls

## Context

A platform-scope review (which Cloudflare services to adopt vs. keep portable)
concluded that homeranger already uses Cloudflare for the layer it should — the
network/storage edge (R2, Tunnel, Access, WAF, DNS) — while the stateful core
(Postgres+pgvector, BullMQ/Redis, Node-on-K8s, Resend, Claude, Voyage) stays
deliberately portable and off the Workers serverless paradigm. The review found
exactly **one** Cloudflare service that is *additive and complementary* rather
than a migration: **AI Gateway**.

The app makes metered `@anthropic-ai/sdk` calls (M4 Claude structured
extraction; M5 adds Haiku vision scoring + the LLM top-K re-rank). Today these
calls have no token/cost analytics, no caching, no shared retry/observability —
each provider is hit directly with no operator visibility.

## Decision

**Route the Anthropic calls through a Cloudflare AI Gateway** — a transparent
proxy. The app keeps its own `ANTHROPIC_API_KEY` and only sets the SDK `baseURL`
to `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic`, gaining
request/token/cost analytics, optional response caching, retries, and a queryable
request log **without changing the model, the prompt, or the call sites**.

- **Infra:** `infra/terraform/cloudflare/ai-gateway.tf` provisions one
  `cloudflare_ai_gateway` ("homeranger") in the same CF account as R2. `collect_logs`
  on (the analytics this exists for); caching + rate-limiting off by default;
  `authentication` off by default (var-flippable).
- **App:** `packages/backend-core/src/lib/ai/ai-gateway.ts` builds the gateway
  `baseURL` (+ optional `cf-aig-authorization` header) from env;
  `createAnthropicClient()` in `claude-extraction.provider.ts` spreads it into the
  Anthropic client. Mirrors the existing `createR2Client(config)` factory shape.
- **Scope now:** Anthropic-family only — Claude extraction (M4) plus M5 Haiku
  vision + match-scoring, all of which reuse `anthropicGatewayClientOptions`
  (`anthropic` is a supported gateway provider). **Voyage embeddings do NOT ride
  the gateway:** Cloudflare has no Voyage provider, so a `/voyage` path is
  rejected with AiGatewayError 2008 "Invalid provider" (confirmed 2026-06-04
  against CF's supported-providers list — analyze:listing was producing zero
  embeddings in prod). `voyageEmbeddingsEndpoint` posts direct to
  `api.voyageai.com`; restore a gateway branch only if CF adds a Voyage provider.

### Why this and nothing else from the CF compute/data stack
The same review rejected migrating the compute/data core: the current code
depends on features the CF equivalents lack or break — BullMQ `jobId` dedup
(Cloudflare Queues has none), same-transaction pgvector dedup (Vectorize is
eventually consistent), and `@aws-sdk/client-s3` (broken on Workers). Workers AI
hosts no Claude model. AI Gateway is the only piece that adds value without
touching that core.

## Reversibility (swappable-provider rule)

Activation is **env-driven and optional**. With `CF_AI_GATEWAY_ACCOUNT_ID` /
`CF_AI_GATEWAY_ID` unset, the helper returns empty options and the SDK calls
Anthropic directly — the local-dev, unit-test, and CI path (`EXTRACTION_FAKE=1`
short-circuits the LLM anyway). Unsetting the env reverts to direct calls with
**zero code change**, the same reversibility the email/embedding decisions hold.
Because the app degrades gracefully without the gateway, `ai-gateway.tf` can be
applied independently of wiring the app env — no chicken-and-egg ordering.

## Residency

When enabled, prompts/responses transit Cloudflare's edge and logs are stored on
Cloudflare. This is **consistent with the already-waived US-Anthropic residency
posture** (see `2026-06-01-email-provider-vendor.md`) and does **not** widen it
to any new data class — the same listing/email text already goes to Anthropic in
the US. If residency ever tightens, the gateway exposes a Zero-Data-Retention
lever (`zdr=true` + `collect_logs=false`), at the cost of the analytics this
adoption exists for; the cleaner escape hatch remains unsetting the env entirely.

## Consequences

- Add (optional) secrets: `CF_AI_GATEWAY_ACCOUNT_ID`, `CF_AI_GATEWAY_ID`,
  `CF_AI_GATEWAY_TOKEN` (token only for an authenticated gateway). Wired into the
  processor Deployment with `optional: true` so a secret without them still boots.
- `tofu apply` (or `-target=cloudflare_ai_gateway.homeranger`) creates the gateway;
  the GitHub Actions CF token already in use covers it. Free at this volume.
- No app behaviour change when the gateway is off; identical extraction results
  when on (same model, same prompt).
