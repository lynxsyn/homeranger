/**
 * Integration test for agentRepository.list cursor pagination. Proves the
 * uuid(7) id keyset paginates with NO skip and NO overlap even when many agents
 * are created within the same millisecond (the case the previous ms-truncated
 * timestamp cursor could duplicate at a page boundary). M2 review fix.
 *
 * Gate: integration project only (VITEST_INTEGRATION=1 + DATABASE_URL).
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  cleanupTestData,
  disconnectTestPrisma,
  getTestPrisma,
} from "../test/db-helper.js";
import { agentRepository } from "./agent.repository.js";

const db = getTestPrisma();

beforeEach(async () => {
  await cleanupTestData(db);
});
afterEach(async () => {
  await cleanupTestData(db);
});
afterAll(async () => {
  await disconnectTestPrisma();
});

describe("agentRepository.list cursor pagination (uuid7 id keyset)", () => {
  it("paginates all agents with no skip and no overlap (same-millisecond creation)", async () => {
    const total = 7;
    // Tight loop so several rows share a createdAt millisecond. `test-` prefix
    // so cleanupTestData removes them.
    for (let i = 0; i < total; i += 1) {
      await agentRepository.upsertByEmail({
        email: `test-m2-agent-pg-${i}@example.com`,
        agencyName: `Agency ${i}`,
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await agentRepository.list({ limit: 2, cursor });
      seen.push(...page.items.map((a) => a.id));
      if (!page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
    }

    expect(seen).toHaveLength(total); // no skip
    expect(new Set(seen).size).toBe(total); // no overlap / no duplicate
  });
});

describe("agentRepository.upsertByEmail website round-trip", () => {
  it("persists a website on create and updates it on a later upsert, leaving it untouched when omitted", async () => {
    // Create with a website.
    const created = await agentRepository.upsertByEmail({
      email: "test-website@agency.example",
      agencyName: "Website Agency",
      website: "https://agency.example",
    });
    expect(created.website).toBe("https://agency.example");

    // Re-upsert WITHOUT a website (e.g. a caller that does not touch it) leaves
    // the stored value intact — `undefined` is not written.
    const untouched = await agentRepository.upsertByEmail({
      email: "test-website@agency.example",
      agencyName: "Website Agency (renamed)",
    });
    expect(untouched.website).toBe("https://agency.example");

    // Re-upsert WITH a new website overwrites it.
    const updated = await agentRepository.upsertByEmail({
      email: "test-website@agency.example",
      agencyName: "Website Agency",
      website: "https://agency.example/contact",
    });
    expect(updated.website).toBe("https://agency.example/contact");
  });
});

describe("agentRepository.wasDomainContactedSince (per-domain cooldown)", () => {
  it("finds a recently-contacted sibling mailbox, excluding self, stale, and other domains", async () => {
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 3_600_000); // 1 day ago

    const a = await agentRepository.upsertByEmail({
      email: "test-conwy@fp.example",
      agencyName: "Fletcher & Poole",
    });
    const b = await agentRepository.upsertByEmail({
      email: "test-lettings@fp.example",
      agencyName: "Fletcher & Poole",
    });
    const other = await agentRepository.upsertByEmail({
      email: "test-info@other.example",
      agencyName: "Other Agency",
    });
    // a (same domain as b) + other (different domain) are contacted; b is not.
    await agentRepository.markContacted(a.id, now);
    await agentRepository.markContacted(other.id, now);

    // b's domain has a recently-contacted sibling (a) → blocked.
    expect(
      await agentRepository.wasDomainContactedSince("fp.example", since, b.id),
    ).toBe(true);
    // Excluding a itself (the only contacted mailbox at fp.example) → clear.
    expect(
      await agentRepository.wasDomainContactedSince("fp.example", since, a.id),
    ).toBe(false);
    // A future `since` makes a's contact stale → clear.
    const future = new Date(now.getTime() + 3_600_000);
    expect(
      await agentRepository.wasDomainContactedSince("fp.example", future, b.id),
    ).toBe(false);
    // other.example's only contacted mailbox is `other` itself → excluding it, clear
    // (and fp.example's contacts never leak across the domain boundary).
    expect(
      await agentRepository.wasDomainContactedSince(
        "other.example",
        since,
        other.id,
      ),
    ).toBe(false);
  });
});
