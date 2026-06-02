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

## Collection conduct

- Respect site `robots.txt` / terms via the discovery vendor's compliant fetch.
- Dedup on email; store provenance (source URL) for accountability.
- Retain a suppression as a do-not-contact record even after erasing other data.
- Discovery is operator-triggered per region (not a continuous crawl).

## Review

Re-assessed if the vendor, regions, or volume change materially. The
classification + skip-suppressed logic is covered by the discovery-service unit +
integration tests.
