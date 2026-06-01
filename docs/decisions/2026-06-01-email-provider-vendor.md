---
decision_id: 2026-06-01-email-provider-vendor
status: accepted
date: 2026-06-01
gate: M0 — commodity-gate (aide/rules/commodity-gate.md)
supersedes: none
---

# Decision: Email provider = Resend (residency criterion #1 consciously waived)

## Context

homescout's primary (and, per the data-source decision, **only**) live source is autonomous-but-guarded cold B2B outreach to UK estate agents, plus ingestion of their replies (free text + PDF/image attachments) and reaction to bounce/complaint events for an automated circuit breaker. This requires a provider that does **send + inbound-parse webhook + bounce/complaint webhooks**, behind a thin swappable interface.

The workspace commodity gate (`aide/rules/commodity-gate.md`) makes **UK/EEA data residency (storage AND processing of account data, metadata, logs) the hard criterion #1**. A US-resident vendor fails it unless every processing path is contractually bound to an EEA region.

## Options evaluated (June 2026 research)

| Provider | Residency (storage+processing) | Inbound parse | Bounce/complaint webhook | Cold-B2B AUP | Low-vol price |
|---|---|---|---|---|---|
| **Resend** | **FAIL** — account data/metadata/logs in US (SCC) even sending from Ireland | Yes | Yes | **Permits compliant cold B2B** | Generous free tier; cheap |
| Mailjet (Sinch) | PASS (GCP Frankfurt/Belgium) | Yes (JSON) | Yes | Prohibits cold | ~$9/mo min |
| Brevo | PASS (OVH FR/DE) | Yes | Yes | Prohibits cold | PAYG credits |
| AWS SES eu-west-1 | PASS (Ireland) | Yes (S3+Lambda+SNS) | Yes (SNS) | Prohibits cold | ~$0.10/1k |
| Scaleway TEM | PASS++ (FR, no EU egress) | **NO (send-only)** → disqualified | Yes | Transactional only | €0.25/1k |
| SendGrid EU | QUALIFIED (event data EU; metadata may leave) | Yes | Yes | Prohibits cold | ~$20/mo min |

Two findings shaped the decision:
1. **Every ESP's AUP restricts cold email.** This is not differentiating — it is handled the same way regardless of vendor: the `ComplianceGuard` only sends to `mailboxType=corporate_subscriber` mailboxes (PECR corporate-subscriber carve-out), on a documented legitimate-interest basis, with honoured one-click unsubscribe. Resend is the one candidate whose AUP *explicitly* permits compliant cold B2B, so it is the least friction here.
2. **The only failing for Resend is residency** — it is otherwise a clean technical fit (inbound parse + bounce/complaint webhooks + best DX).

## Decision

**Use Resend**, wrapped behind an `EmailProvider` + `MailboxAdapter` interface, with `nodemailer` SMTP retained as the swappable fallback transport.

**Residency criterion #1 is consciously WAIVED** for this single-user personal tool. Resend stores account data/metadata/logs in the US under SCCs. This is an accepted, documented exception — not an oversight. The `EmailProvider` interface keeps the choice reversible: if residency becomes a hard requirement later, Mailjet (clean EU, JSON inbound) is the drop-in replacement and AWS SES eu-west-1 (cheapest, heavier S3/Lambda inbound) is the runner-up.

### Why the waiver is defensible here
- Single-user, self-hosted, non-commercial personal tool — no third-party data subjects beyond the agents being contacted on business addresses.
- The sensitive payloads (listing/agent data) still get a separate, explicit residency call in the embedding-model decision; this waiver is scoped to *email transport metadata*.
- GDPR posture is carried by the corporate-only legitimate-interest basis + ROPA + honoured unsubscribe (see M6 spec), independent of where the ESP stores logs.

## Anthropic usage note (recorded here to avoid a future mistake)

The runtime `@anthropic-ai/sdk` calls (email field extraction, Haiku vision taste-scoring, top-K LLM re-rank) require a **metered `ANTHROPIC_API_KEY`** from the Anthropic Console. The **Max subscription authorizes interactive use only** (Claude.ai / Claude Code) and **cannot back the deployed homescout service** — its OAuth tokens are interactive-scoped and using a personal subscription to power a separate service violates the usage terms. Anthropic offers **no embeddings endpoint**; the vector layer uses Voyage (see the embedding decision).

## DNS records required (own dedicated zone — see M1)

- **DKIM**: CNAME(s) per Resend domain setup.
- **Return-Path / MAIL FROM**: CNAME per Resend.
- **SPF**: TXT including Resend's sending hosts.
- **DMARC**: TXT, `p=none` during warmup → tighten to `p=quarantine`.

Records go in homescout's own Terraform (`infra/terraform/cloudflare/`), mirroring the shape of `doxus-infra/terraform/cloudflare/dns.tf`.

## Consequences

- Add secrets: `RESEND_API_KEY`, `RESEND_INBOUND_WEBHOOK_SECRET` (and `RESEND_WEBHOOK_SECRET` for delivery/bounce/complaint events).
- Webhook route shape (M4) follows Resend's inbound-parse + event payloads (signature verification via Node `crypto` HMAC + Zod), mirroring `email-ingestion.route.ts`.
- The `EmailProvider`/`MailboxAdapter` interface is mandatory — no direct Resend SDK calls outside the adapter — so the waiver stays reversible.
