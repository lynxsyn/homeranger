# Follow-up: make HTTP 404 non-retryable in extraction (fold into M5)

**Source:** live-edge adversarial review (ops/live-edge-tunnel-cf-access), HIGH finding (defense-in-depth half).

**Live risk: NONE right now.** The AI Gateway `homescout` exists and proxies to Anthropic (verified: a Haiku call through gateway.ai.cloudflare.com/.../homescout/anthropic returns 200). So extraction does not 404 today.

**The latent gap:** `packages/backend-core/src/lib/ai/claude-extraction.provider.ts` `isRetryableStatus()` treats 404 as retryable (it isn't 429/529/>=500/400/401/403, so it hits the final `return true`). If the AI Gateway env (`CF_AI_GATEWAY_ID`/`CF_AI_GATEWAY_ACCOUNT_ID`) is ever pointed at a missing/renamed gateway, every inbound-email extraction would 404 and burn all BullMQ attempts (attempts:3 + backoff) on a permanent error — wasted spend + log churn, zero extractions, mis-classified as transient.

**Fix (do in M5, which rebuilds the processor image anyway):**
- In `isRetryableStatus()` treat 404 (and ideally 405/410) as terminal → `return false`, so a misconfigured/absent gateway fails fast (→ UnrecoverableError + drop metric) instead of retrying.
- Add a unit test: a 404 from the provider is classified non-retryable.

Not done in the live-edge PR to keep it image-free (no processor rebuild / tag bump). M5 touches the extraction/analyze path, so it lands there.
