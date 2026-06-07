# Legitimate Interest Assessment (LIA) — homeranger outbound outreach

> **Scope:** the M6 outbound outreach path — autonomous-but-guarded cold B2B
> email to UK estate-agent **corporate** mailboxes, and the ingestion of their
> replies. Single-user, self-hosted, non-commercial personal tool.
>
> **Lawful basis for sending:** PECR reg. 22 corporate-subscriber carve-out
> (B2B email to a corporate subscriber does not require prior consent) +
> **GDPR Art. 6(1)(f) legitimate interests** for processing the agent's
> business-contact personal data. This document is the recorded LIA backing
> that basis; the ROPA (`ropa.md`) is the processing record.

## 1. Purpose test — is there a legitimate interest?

Yes. The operator (a private buyer) has a legitimate interest in discovering
suitable properties — including pre-market / upcoming instructions — by
contacting estate agents who publicly market homes in the operator's target
areas. Contacting agents on their **published business addresses** about the
service they offer (selling property) is a routine, expected B2B interaction.

## 2. Necessity test — is the processing necessary?

Yes, and it is minimised. Email to the agent's business address is the
established channel for buyer enquiries. The processing is limited to:
- the agent's **business** email, agency name, branch contact name, and the
  outcodes they cover (all from public listing sources);
- the minimum needed to send a relevant enquiry and follow up on a reply.

No special-category data. No data about identifiable consumers. The draft is a
**deterministic template** (see §5) — no free-text agent data is fed to an LLM
on the send path, so the send introduces no new processing of personal data
beyond transport.

## 3. Balancing test — do the agent's interests override?

No, provided the load-bearing safeguards below hold. The recipients are
businesses contacted on business addresses about their own line of work; the
intrusion is low and within their reasonable expectations. The balance is held
by the `ComplianceGuard` and the honoured opt-out:

| Safeguard | Mechanism (M6) |
|---|---|
| Corporate-only (PECR reg. 22) | Gate 1 — `mailboxType === corporate_subscriber`; individual/unknown ⇒ never sent. |
| Honoured objection / opt-out | Gate 2 — `Agent.optedOut`; set by one-click unsubscribe + inbound STOP. |
| Global do-not-contact | Gate 3 — `SuppressionEntry` (unsubscribe / hard-bounce / complaint / manual). |
| Deliverability verification | Gate 4 — discovery's SMTP probe (MX + RCPT TO, no message sent) flags a confirmed-dead mailbox `undeliverable`; never sent, so we do not repeatedly hard-bounce a dead address. |
| One approach per agency | Gate 5 — per-domain cooldown: at most one cold approach per email domain per `DOMAIN_COOLDOWN_DAYS` (default 30), across every mailbox discovery surfaces for it. |
| Reputation circuit breaker | Gate 6 — halts sends if bounce > 2% or complaint > 0.1% over the rolling window (min-sample guarded). |
| Manual kill-switch | Gate 7 — operator can halt ALL sends instantly. |
| Volume warm-up cap | Gate 8 — per-day token bucket, fail-closed. |
| One-click unsubscribe | RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post`, HMAC-token, idempotent — writes `SuppressionEntry(unsubscribe)` + opts the agent out + closes the thread. |
| Right to object honoured immediately | A suppression / opt-out short-circuits every future send (gates 2 & 3), permanently. |

## 4. Data-subject rights

- **Right to object (Art. 21):** honoured by the one-click unsubscribe and the
  inbound STOP detection — both write a permanent suppression + opt-out.
- **Access / erasure:** single-user store; the operator can delete an agent's
  rows on request (`Agent`, `OutreachThread`, `OutreachMessage`, `EmailEvent`,
  `SuppressionEntry`). A suppression is retained as a do-not-contact record
  (suppression-list exemption) even after erasure of correspondence.
- **Transparency:** every outbound email identifies the sender and carries the
  one-click unsubscribe header + footer link.

## 5. LLM / automated-processing note (AC#5)

The outreach **draft is template-generated — there is NO LLM call on the send
path**, so no agent personal data is sent to a model when composing or sending
outreach. The system's *other* LLM/embedding calls (M4 inbound listing
extraction, M5 vision taste-scoring + match re-rank) DO process agent-supplied
content; their no-training / retention posture is recorded in `ropa.md §
Processors & LLM posture`. There is no solely-automated decision producing legal
or similarly significant effects on the agent (Art. 22): the agent is contacted,
not subjected to a decision about them.

## 6. Review

Reviewed when the safeguards, vendors, or sending volume materially change.
The `ComplianceGuard` unit tests + the guard E2E are the executable proof that
the §3 safeguards remain enforced.
