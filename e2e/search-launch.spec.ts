/**
 * Search LAUNCH loop E2E (M8 PR3) — discover → review → approve → guarded send,
 * proven end-to-end against REAL infra (api + pgvector + redis + the BullMQ
 * worker), deterministic + network-free:
 *
 *   - DISCOVERY_FAKE=1 — `search.launch` enqueues `discover:agents` for the
 *     search's outcodes; the FakeAgentDiscoveryProvider mints stable
 *     business-domain agents (classified `corporate_subscriber`), so the
 *     ComplianceGuard PECR gate lets a send through. No Firecrawl/scrape/spend.
 *   - OUTREACH_FAKE=1 — the approved send dispatches via the fake email provider
 *     (stable providerMessageId), so an outbound OutreachMessage row lands.
 *
 * Two arms, isolated by a UNIQUE synthetic outcode per search (parsed verbatim by
 * resolveSearchOutcodes), so the discovered agents + every assertion + cleanup
 * key off `coveredOutcodes @> {<outcode>}`:
 *   1. Golden path — Launch opens the modal (auto-discovers + auto-reviews); the
 *      eligible agents are pre-checked; Approve & send → an OUTBOUND
 *      OutreachMessage is persisted for an agent in the patch.
 *   2. Kill-switch — flip the global kill-switch ON first → Launch → review marks
 *      EVERY agent ineligible (gate 5), so "Approve & send" is disabled and NO
 *      OutreachMessage can be written. afterEach restores the switch OFF.
 *
 * Auth: dev-bypass (CF_ACCESS_* unset). The search is created via tRPC-over-HTTP
 * (superjson `{ json }`, like outreach-guard.spec); the LAUNCH loop is driven
 * through the real /searches UI. Cleanup uses a raw pg Client.
 */
import { expect, test } from "@playwright/test";
import { Client } from "pg";

const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:3000";
const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://homeranger:homeranger@localhost:5434/homeranger";

const RUN_ID = Date.now().toString(36);

// The review modal is tall + scrollable; a desktop-height viewport keeps the
// agent rows + approve control reachable.
test.use({ viewport: { width: 1280, height: 1000 } });

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** tRPC v11 over HTTP, superjson transformer → inputs wrap as `{ json }`. */
function createSearch(
  request: import("@playwright/test").APIRequestContext,
  input: Record<string, unknown>,
) {
  return request.post(`${API_BASE}/trpc/searches.create`, {
    headers: { "content-type": "application/json" },
    data: { json: input },
    failOnStatusCode: false,
  });
}

function searchNameFrom(body: unknown): string {
  const name = (
    body as { result?: { data?: { json?: { name?: string } } } }
  )?.result?.data?.json?.name;
  if (!name) {
    throw new Error(`searches.create returned no search: ${JSON.stringify(body)}`);
  }
  return name;
}

/** Count OUTBOUND OutreachMessages to any agent whose patch covers `outcode`. */
function countOutboundForOutcode(outcode: string): Promise<number> {
  return withClient(async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM "OutreachMessage" m
         JOIN "OutreachThread" t ON t.id = m."threadId"
         JOIN "Agent" a ON a.id = t."agentId"
        WHERE m.direction = 'outbound'
          AND a."coveredOutcodes" @> ARRAY[$1]::text[]`,
      [outcode],
    );
    return Number(rows[0]?.count ?? "0");
  });
}

/** How many agents discovery upserted into `outcode` (drives polling). */
function countAgentsForOutcode(outcode: string): Promise<number> {
  return withClient(async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "Agent"
        WHERE "coveredOutcodes" @> ARRAY[$1]::text[]`,
      [outcode],
    );
    return Number(rows[0]?.count ?? "0");
  });
}

/** Set the global kill-switch (M6 WarmupState, single row) directly in pg. */
function setKillSwitch(enabled: boolean): Promise<void> {
  return withClient(async (client) => {
    await client.query(
      `INSERT INTO "WarmupState" (id, "windowDate", "killSwitch", "updatedAt")
         SELECT gen_random_uuid(), date_trunc('day', now() AT TIME ZONE 'utc'), $1, now()
        WHERE NOT EXISTS (SELECT 1 FROM "WarmupState")`,
      [enabled],
    );
    await client.query(`UPDATE "WarmupState" SET "killSwitch" = $1`, [enabled]);
  });
}

/** Remove every artefact this spec created for `outcode`. */
async function cleanupForOutcode(outcode: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `DELETE FROM "OutreachMessage"
         WHERE "threadId" IN (
           SELECT t.id FROM "OutreachThread" t
           JOIN "Agent" a ON a.id = t."agentId"
           WHERE a."coveredOutcodes" @> ARRAY[$1]::text[])`,
      [outcode],
    );
    await client.query(
      `DELETE FROM "OutreachThread"
         WHERE "agentId" IN (
           SELECT id FROM "Agent" WHERE "coveredOutcodes" @> ARRAY[$1]::text[])`,
      [outcode],
    );
    await client.query(
      `DELETE FROM "Agent" WHERE "coveredOutcodes" @> ARRAY[$1]::text[]`,
      [outcode],
    );
  });
}

test.afterEach(async () => {
  // Never leave the global kill-switch flipped — sibling specs send for real.
  await setKillSwitch(false);
});

test.afterAll(async () => {
  await withClient(async (client) => {
    await client.query(`DELETE FROM "Search" WHERE "name" LIKE 'E2E PR3%'`);
  });
});

test("search launch golden path: launch → discover → review → approve → guarded send persists an OutreachMessage", async ({
  page,
  request,
}) => {
  const OUTCODE = "ZZ7";
  const SEARCH_NAME = `E2E PR3 Launch ${RUN_ID}`;
  await cleanupForOutcode(OUTCODE);
  await setKillSwitch(false);

  const res = await createSearch(request, {
    name: SEARCH_NAME,
    location: `Test patch — ${OUTCODE}`,
    types: ["Terraced"],
    condition: [],
    land: [],
    saleMethods: ["Private treaty"],
    minBedrooms: null,
    maxPricePence: null,
    keywords: "bright period terrace",
    status: "active",
  });
  expect(res.status()).toBe(200);
  expect(searchNameFrom(await res.json())).toBe(SEARCH_NAME);

  await page.goto("/searches");
  await expect(page.getByRole("heading", { name: "Searches" })).toBeVisible();
  const card = page.locator(
    `[data-testid="search-card"][data-search-name="${SEARCH_NAME}"]`,
  );
  await expect(card).toHaveCount(1);

  // Launch → opens the modal, which auto-fires discovery then auto-reviews.
  await card.getByTestId("search-launch").evaluate((el) => (el as HTMLElement).click());
  await expect(page.getByTestId("launch-modal")).toBeVisible();

  // Discovery is async; wait until the fake provider's agents land in the patch.
  await expect
    .poll(() => countAgentsForOutcode(OUTCODE), { timeout: 25_000 })
    .toBeGreaterThan(0);

  // The modal polls reviewDrafts until the agents render; the woven draft shows.
  await expect(page.getByTestId("launch-draft")).toContainText("private buyer");
  const eligibleRow = page.locator(
    '[data-testid="launch-agent"][data-eligible="true"]',
  );
  await expect(eligibleRow.first()).toBeVisible({ timeout: 25_000 });

  // Eligible agents are pre-checked → Approve & send is enabled.
  const approve = page.getByTestId("launch-approve");
  await expect(approve).toBeEnabled();
  await approve.evaluate((el) => (el as HTMLElement).click());
  await expect(page.getByTestId("launch-sent")).toBeVisible();

  // The approved send passes the worker guard (reserve:true) + fake provider →
  // an outbound OutreachMessage for an agent in this patch is persisted.
  await expect
    .poll(() => countOutboundForOutcode(OUTCODE), { timeout: 25_000 })
    .toBeGreaterThan(0);

  await cleanupForOutcode(OUTCODE);
});

test("kill-switch halts the launch loop: every agent is ineligible and Approve is disabled", async ({
  page,
  request,
}) => {
  const OUTCODE = "ZZ8";
  const SEARCH_NAME = `E2E PR3 Killswitch ${RUN_ID}`;
  await cleanupForOutcode(OUTCODE);

  const res = await createSearch(request, {
    name: SEARCH_NAME,
    location: `Test patch — ${OUTCODE}`,
    types: ["Terraced"],
    condition: [],
    land: [],
    saleMethods: ["Private treaty"],
    minBedrooms: null,
    maxPricePence: null,
    keywords: "quiet street",
    status: "active",
  });
  expect(res.status()).toBe(200);

  // Flip the GLOBAL kill-switch ON via Settings → Outreach (it lives there now,
  // not on Searches) and confirm it reports enabled.
  await page.goto("/settings");
  await expect(page.getByTestId("settings-outreach")).toBeVisible();
  const killSwitch = page.getByTestId("kill-switch");
  await killSwitch.getByRole("switch").evaluate((el) => (el as HTMLElement).click());
  await expect(killSwitch).toHaveAttribute("data-enabled", "true");

  // Now open the search and launch + wait for discovery.
  await page.goto("/searches");
  const card = page.locator(
    `[data-testid="search-card"][data-search-name="${SEARCH_NAME}"]`,
  );
  await expect(card).toHaveCount(1);
  await card.getByTestId("search-launch").evaluate((el) => (el as HTMLElement).click());
  await expect(page.getByTestId("launch-modal")).toBeVisible();
  await expect
    .poll(() => countAgentsForOutcode(OUTCODE), { timeout: 25_000 })
    .toBeGreaterThan(0);

  // The agents render — but the kill-switch (gate 5) marks EVERY one ineligible,
  // so there are no eligible rows and Approve & send stays disabled. No send can
  // leave: the operator is blocked at the review gate.
  await expect
    .poll(async () => page.getByTestId("launch-agent").count(), { timeout: 25_000 })
    .toBeGreaterThan(0);
  await expect(
    page.locator('[data-testid="launch-agent"][data-eligible="true"]'),
  ).toHaveCount(0);
  await expect(page.getByTestId("launch-approve")).toBeDisabled();

  // Belt-and-braces: nothing was sent for this patch.
  expect(await countOutboundForOutcode(OUTCODE)).toBe(0);

  await cleanupForOutcode(OUTCODE);
});
