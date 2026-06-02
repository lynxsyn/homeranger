# Record of Processing Activities (ROPA) — homescout

> GDPR Art. 30 record for the homescout outbound-outreach + listing-ingestion
> processing. Single-user, self-hosted, non-commercial personal tool. Template
> shape mirrors the Doxus ROPA. Paired with the LIA
> (`legitimate-interest-basis.md`).

## Controller

| Field | Value |
|---|---|
| Controller | The operator (single private individual running homescout self-hosted). |
| Contact | The operator's own mailbox (see deployment secret). |
| DPO | Not required (no large-scale or special-category processing). |

## Processing activity 1 — Outbound estate-agent outreach

| Field | Value |
|---|---|
| Purpose | Discover suitable / pre-market properties by contacting estate agents on their business addresses. |
| Lawful basis | PECR reg. 22 (corporate-subscriber B2B email) + GDPR Art. 6(1)(f) legitimate interests (LIA recorded). |
| Data subjects | Estate agents / branches (businesses + named business contacts). |
| Personal data | Business email, agency name, branch contact name, covered outcodes, message correspondence, delivery/bounce/complaint events. No special-category data. |
| Source | Public property-listing sources (agent emails / listings). |
| Recipients (processors) | Resend (email send + inbound + events), Cloudflare (edge + AI Gateway proxy), Anthropic (listing extraction / vision / match — see LLM posture), Voyage (embeddings). |
| Retention | Correspondence retained while the outreach relationship is active; suppression records retained indefinitely as a do-not-contact list (the privacy-protective exception). Operator may erase correspondence on request. |
| International transfers | Resend + Anthropic store data in the US under SCCs (residency criterion consciously waived for this single-user tool — `docs/decisions/2026-06-01-email-provider-vendor.md`); Cloudflare edge transit. |
| Security | CF Access on the app; SOPS-encrypted secrets; webhook signature verification (Svix); HMAC one-click-unsubscribe tokens; fail-closed rate limiting; no PII/secrets in logs (logs carry agentId/uuid + codes only). |
| Data-subject rights | Right to object honoured by one-click unsubscribe (RFC 8058) + inbound STOP → permanent suppression + opt-out; access/erasure on request. |

## Processing activity 2 — Inbound reply + listing ingestion

| Field | Value |
|---|---|
| Purpose | Parse agent replies + listing emails into de-duplicated `Listing` records; link replies to the originating `OutreachThread`. |
| Lawful basis | Art. 6(1)(f) legitimate interests (same buyer-search interest). |
| Personal data | Sender business email, message body/attachments, SPF/DKIM verdicts. |
| Processors | Resend (inbound hydrate), Cloudflare R2 (attachment store), Anthropic (extraction), Voyage (embeddings). |
| Retention | As activity 1. |

## Processors & LLM posture (AC#5 — no-training / zero-retention)

The outreach **draft is template-generated; there is NO LLM call on the send
path**, so composing/sending outreach sends no agent personal data to a model.
The remaining model calls and their posture:

| Call | Vendor | Posture |
|---|---|---|
| Listing extraction, vision taste-score, match re-rank | Anthropic (commercial API, metered `ANTHROPIC_API_KEY`) | Anthropic's **commercial API does not train on inputs/outputs** by default (commercial terms). Default trust-&-safety retention (~30 days) applies UNLESS a Zero-Data-Retention agreement is in place — true ZDR is a **contractual** action with Anthropic, NOT a header. The interactive Max subscription is **not** used to back the deployed service (decision doc note). |
| Embeddings | Voyage (`voyage-3.5`) | Per Voyage commercial terms; documented residency call in the embedding decision. |
| Gateway proxy | Cloudflare AI Gateway (optional, env-gated) | Transparent proxy. Gateway-side request logging can be minimised (`cf-aig-collect-log`) as future defence-in-depth; it is **log minimisation only**, not a provider no-training/zero-retention guarantee, so it is documented here rather than asserted in code. |

**Posture summary for AC#5:** no-training is satisfied by using Anthropic's
commercial API (no training by default) + Voyage commercial terms; true
zero-retention, if required, is a contractual ZDR action with the providers.
The outreach send path itself is template-only and introduces no LLM retention
surface.

## Breach / incident

Self-hosted single-user tool: the operator is the sole point of contact. The
circuit breaker + kill-switch provide an immediate halt for a sender-reputation
or compliance incident.
