# Agent-sourcing legitimate-interest basis (M7)

> **Scope:** SOURCING — how estate-agent contact details enter the system for
> cold B2B outreach (M7 autonomous discovery). The SENDING basis is the M6
> ComplianceGuard + `legitimate-interest-basis.md`; this records the lawful basis
> for COLLECTING the contacts. Single-user, self-hosted, non-commercial tool.

## What is collected, and from where

Public **business** contact details of UK estate agencies — agency name, a
business email (e.g. `info@agency.co.uk`), and the source website URL — gathered
by web search/extract over publicly-published agency pages for a chosen region.
No special-category data; no consumer/data-subject data beyond the agency's own
published business contact.

## Lawful basis — GDPR Art. 6(1)(f) legitimate interests

- **Purpose:** identify estate agents operating in a target region so the operator
  can make a relevant B2B buyer enquiry (the same legitimate interest as the M6
  send LIA).
- **Necessity:** there is no compliant live listing API (data-source decision);
  agent email is the sole live channel, so a contact list per region is necessary
  to use it. Collection is minimised to the published business contact.
- **Balancing:** the data is a business's *own publicly-published* contact for the
  purpose of being contacted about its services; intrusion is low and within
  reasonable expectations. The balance is held by:
  - **Classification gate:** only a business/agency-domain mailbox is classified
    `corporate_subscriber`; a free-webmail (personal) mailbox is classified
    `individual` and is **never cold-emailed** (ComplianceGuard gate 1). So a
    discovered personal mailbox is not pursued.
  - **The full M6 backstops** apply to any send: PECR corporate-only, suppression,
    one-click unsubscribe + inbound STOP, circuit breaker, kill-switch.

## Art. 14 (information to data subjects not collected from them)

The first outreach email serves as the privacy notice: it identifies the sender,
states the purpose (a buyer enquiry), and carries the one-click unsubscribe
(`List-Unsubscribe`) + footer link. An unsubscribe/STOP writes a permanent
`SuppressionEntry` + opt-out, and a suppressed contact is **skipped at discovery**
(never re-sourced).

## Classification is a best-effort heuristic (known limitation)

Mailbox classification is a domain DENYLIST: a free-webmail domain ⇒ `individual`
(blocked); anything else ⇒ `corporate_subscriber` (cold-emailable). This can
misjudge two edges: (a) a sole-trader on a custom domain (not truly a corporate
subscriber) classified corporate, and (b) an unlisted webmail provider classified
corporate. Mitigations: the denylist is kept reasonably broad; the first email is
identifiable + carries one-click unsubscribe (a misjudged recipient opts out in one
click → permanent suppression); and **M8 surfaces discovered agents for operator
review before a campaign sends** (human-in-the-loop on the PECR boundary). The
guard, suppression, and unsubscribe are the backstops for any misclassification.

## Collection conduct

- The discovery vendor performs the fetch; configure it to honour `robots.txt`
  where supported and confirm the vendor's robots/ToS handling before enabling
  (not guaranteed in our code — verify per the vendor decision doc).
- Dedup on email; store provenance (source URL) for accountability.
- Retain a suppression as a do-not-contact record even after erasing other data.
- Discovery is operator-triggered per region (not a continuous crawl).
- Recall uses a bounded multi-query fan-out (estate/letting/independent + per-outcode) plus best-effort structured extraction of an agency contact page when no email is plaintext in the search result; both stay within the public-business-contact, robots-honouring, operator-triggered basis above (bounded spend, no continuous crawl).

## Review

Re-assessed if the vendor, regions, or volume change materially. The
classification + skip-suppressed logic is covered by the discovery-service unit +
integration tests.
