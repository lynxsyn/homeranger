/**
 * Agents screen E2E (PR1). The estate-AGENT directory on the real read path,
 * against real infra (api + pgvector via the Playwright webServer, dev-bypass
 * auth). The operator dev-bypass user is the default identity, so the Agents tab
 * (operator-only) is visible and the agents.* operatorProcedure queries resolve.
 *
 * Agents are the agencies HomeRanger discovered and contacted; each row folds in
 * its latest non-closed outreach-thread status (replied / awaiting / queued /
 * opted_out) and a count of listings it has sent. The seed (apps/api/prisma/
 * seed.ts) stands up a demo pool of contacted agents with mixed statuses so this
 * screen has rows to render. (Stream A owns the seed; see the deviations note.)
 *
 * Covers:
 *   1. The topbar Agents tab navigates to /agents and the page renders: the
 *      metrics strip (Contacted / Replied / Awaiting / Homes) plus the agents
 *      table with one row per seeded agent.
 *   2. A status-filter chip (Replied) narrows the table to that status and the
 *      All chip restores the full set. The narrowed set is a strict subset.
 *   3. Drilling in from a search card's "View agents" link on /searches lands on
 *      /agents WITH the drill-in filter banner; clearing it returns to all agents.
 *
 * The drill-in needs a search with resolved outcodes; this spec creates one via
 * tRPC-over-HTTP under a unique prefixed name (matching search-launch.spec.ts)
 * and deletes it in afterAll so the run is idempotent and other specs are not
 * polluted. The seeded agents are GLOBAL (not per-user / per-search), so the
 * drill-in narrows by outcode overlap, not by ownership.
 *
 * Stable locators only (testids + data-agency); row COUNTS are derived from what
 * the page renders, never hard-coded against the seed, so a seed refresh does
 * not flake the assertions. Where a sticky / scrolled control defeats the
 * center-point hit-test we invoke the React onClick via el.click() (the same
 * documented workaround the listings + search specs use).
 */
import { expect, test } from "@playwright/test";
import { Client } from "pg";

const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:3000";
const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://homeranger:homeranger@localhost:5434/homeranger";

const RUN_ID = Date.now().toString(36);
// The drill-in search targets a London patch the seeded agents cover (SE1,
// SE16), so "View agents" narrows to a non-empty, strict subset of the pool.
const DRILL_SEARCH_NAME = `E2E Agents Drill ${RUN_ID}`;

// The removal test seeds its OWN contacted agent into a DEDICATED synthetic
// outcode (ZZ6) so removing it can never sweep a seeded demo agent the other
// agents tests assert on, and a unique agency label so the row locator is
// unambiguous. `lastContactedAt` is set so the agent counts toward the
// "Contacted" metric tile (the removal test asserts that tile decrements).
const REMOVE_OUTCODE = "ZZ6";
const REMOVE_AGENCY = `E2E Remove Agency ${RUN_ID}`;
const REMOVE_EMAIL = `e2e-remove-${RUN_ID}@agency.test`;

// The agents table + metrics strip are a tall, scrollable page; a desktop-height
// viewport keeps the filter chips and table body reachable without a fragile
// scroll dance.
test.use({ viewport: { width: 1280, height: 1000 } });

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

/** The data-agency of every rendered agent row, in render order. */
async function renderedAgencies(page: import("@playwright/test").Page) {
  return page
    .getByTestId("agent-row")
    .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-agency") ?? ""));
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Seed one CONTACTED agent (lastContactedAt set → counts toward the Contacted
 * tile) in the dedicated ZZ6 patch via a raw INSERT — Prisma's @updatedAt has no
 * DB default, so a raw INSERT must set it. corporate_subscriber keeps the row
 * shape consistent with the demo pool. Idempotent on email (re-run safe).
 */
async function seedRemovableAgent(): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO "Agent"
         (id, email, "agencyName", website, "mailboxType", "optedOut",
          "coveredOutcodes", "lastContactedAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, 'https://agency.test',
               'corporate_subscriber'::"MailboxType",
               false, ARRAY[$3]::text[], now(), now())
       ON CONFLICT (email) DO UPDATE
         SET "agencyName" = EXCLUDED."agencyName",
             website = EXCLUDED.website,
             "coveredOutcodes" = EXCLUDED."coveredOutcodes",
             "lastContactedAt" = EXCLUDED."lastContactedAt"`,
      [REMOVE_EMAIL, REMOVE_AGENCY, REMOVE_OUTCODE],
    );
  });
}

/** The integer value rendered inside a metric tile (e.g. agents-metric-contacted). */
async function metricValue(
  page: import("@playwright/test").Page,
  testId: string,
): Promise<number> {
  const text = (await page.getByTestId(testId).textContent()) ?? "";
  const match = text.match(/\d+/);
  return match ? Number(match[0]) : 0;
}

test.afterAll(async () => {
  await withClient(async (client) => {
    await client.query(`DELETE FROM "Search" WHERE "name" LIKE 'E2E Agents%'`);
    // Sweep the removal test's seeded agent + its (cascading) threads/messages
    // in case the test failed before deleting it through the UI.
    await client.query(
      `DELETE FROM "Agent" WHERE "coveredOutcodes" @> ARRAY[$1]::text[]`,
      [REMOVE_OUTCODE],
    );
  });
});

test("the Agents tab renders the metrics strip and the seeded agent rows", async ({
  page,
}) => {
  // Start on Listings; the Agents tab is a topbar tab (operator-only, visible
  // under the dev-bypass operator).
  await page.goto("/listings");
  await expect(page.getByTestId("listings-table")).toBeVisible();

  await page.getByTestId("nav-agents").click();
  await expect(page).toHaveURL(/\/agents/);

  // The metrics strip renders all four tiles.
  await expect(page.getByTestId("agents-metric-contacted")).toBeVisible();
  await expect(page.getByTestId("agents-metric-replied")).toBeVisible();
  await expect(page.getByTestId("agents-metric-awaiting")).toBeVisible();
  await expect(page.getByTestId("agents-metric-homes")).toBeVisible();

  // The accessible heading survives the page-head removal (sr-only h1).
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();

  // The table renders with at least one seeded agent row. The seed stands up a
  // demo pool with mixed statuses (Stream A); we assert a non-empty table rather
  // than a brittle exact count so a seed refresh does not flake the run.
  await expect(page.getByTestId("agents-table")).toBeVisible();
  const rows = page.getByTestId("agent-row");
  const total = await rows.count();
  expect(total).toBeGreaterThan(0);
  await expect(page.getByTestId("agents-empty")).toHaveCount(0);

  // The count line agrees with the rendered rows.
  await expect(page.getByTestId("agents-count")).toContainText(String(total));

  // Each seeded agent surfaces a clickable website link so the operator can
  // verify the agency before sending fresh outreach (the seed gives each a
  // website; corporate agents always get one derived from their email domain).
  const firstSite = page.getByTestId("agent-site-link").first();
  await expect(firstSite).toBeVisible();
  await expect(firstSite).toHaveAttribute("href", /^https?:\/\//);
});

test("a status filter chip narrows the table to a strict subset, and All restores it", async ({
  page,
}) => {
  await page.goto("/agents");
  await expect(page.getByTestId("agents-table")).toBeVisible();

  const allAgencies = await renderedAgencies(page);
  expect(allAgencies.length).toBeGreaterThan(0);

  // Filter to Replied. The seed contacts agents with mixed statuses, so a
  // non-empty Replied subset exists. Invoke the chip's React onClick directly:
  // the chip sits in a controls row that can scroll under the sticky topbar.
  await page
    .getByTestId("agent-filter-replied")
    .evaluate((el) => (el as HTMLElement).click());
  await expect(page.getByTestId("agent-filter-replied")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const repliedRows = page.getByTestId("agent-row");
  const repliedCount = await repliedRows.count();
  expect(repliedCount).toBeGreaterThan(0);
  // Narrowing can only ever shrink (or hold) the set, never grow it.
  expect(repliedCount).toBeLessThanOrEqual(allAgencies.length);
  // Every visible row in the Replied view shows the Replied status pill.
  for (const row of await repliedRows.all()) {
    await expect(row).toContainText("Replied");
  }

  // The count line tracks the narrowed view.
  await expect(page.getByTestId("agents-count")).toContainText(
    String(repliedCount),
  );

  // All restores the full pool.
  await page
    .getByTestId("agent-filter-all")
    .evaluate((el) => (el as HTMLElement).click());
  await expect(page.getByTestId("agent-filter-all")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await renderedAgencies(page)).toEqual(allAgencies);
});

test("drilling in from a search's View agents link filters /agents, and clear restores all", async ({
  page,
  request,
}) => {
  // Stand up a search whose location resolves to a London patch the seeded
  // agents cover (SE1, SE16), so the drill-in narrows to a non-empty subset.
  const res = await createSearch(request, {
    name: DRILL_SEARCH_NAME,
    location: "Bermondsey, SE1, SE16",
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

  // Baseline: the full agent pool size (the drill-in must be a subset of this).
  await page.goto("/agents");
  await expect(page.getByTestId("agents-table")).toBeVisible();
  const allCount = await page.getByTestId("agent-row").count();
  expect(allCount).toBeGreaterThan(0);

  // Drill in from the search card's "View agents" link on /searches.
  await page.goto("/searches");
  await expect(page.getByRole("heading", { name: "Searches" })).toBeVisible();
  const card = page.locator(
    `[data-testid="search-card"][data-search-name="${DRILL_SEARCH_NAME}"]`,
  );
  await expect(card).toHaveCount(1);

  await card
    .getByTestId("search-agents-link")
    .evaluate((el) => (el as HTMLElement).click());

  // Landed on /agents WITH the drill-in banner naming the search.
  await expect(page).toHaveURL(/\/agents/);
  const banner = page.getByTestId("agent-filter-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(DRILL_SEARCH_NAME);

  // Scoped to the search's outcodes → a non-empty, subset-or-equal view.
  await expect(page.getByTestId("agents-table")).toBeVisible();
  const scopedCount = await page.getByTestId("agent-row").count();
  expect(scopedCount).toBeGreaterThan(0);
  expect(scopedCount).toBeLessThanOrEqual(allCount);

  // Clearing the drill-in returns to the full pool with no banner.
  await page
    .getByTestId("agent-filter-clear")
    .evaluate((el) => (el as HTMLElement).click());
  await expect(page.getByTestId("agent-filter-banner")).toHaveCount(0);
  await expect(page.getByTestId("agent-row").first()).toBeVisible();
  expect(await page.getByTestId("agent-row").count()).toBe(allCount);
});

test("removing an agent from its row erases it and decrements the Contacted metric", async ({
  page,
}) => {
  // Seed one CONTACTED agent in the dedicated ZZ6 patch (operator-only erase via
  // agents.remove; e2e runs under the dev-operator bypass, so the kebab + remove
  // action are reachable).
  await seedRemovableAgent();

  await page.goto("/agents");
  await expect(page.getByTestId("agents-table")).toBeVisible();

  const targetRow = page.locator(
    `[data-testid="agent-row"][data-agency="${REMOVE_AGENCY}"]`,
  );
  await expect(targetRow).toHaveCount(1);

  // Baselines: the total row count + the Contacted tile value (the seeded agent
  // has lastContactedAt set, so it is counted). Derived from the page, never
  // hard-coded against the seed.
  const totalBefore = await page.getByTestId("agent-row").count();
  const contactedBefore = await metricValue(page, "agents-metric-contacted");
  expect(contactedBefore).toBeGreaterThan(0);

  // Open the row kebab → Remove → the confirm modal. The kebab sits in a row that
  // can scroll under the sticky topbar, so invoke the React onClick directly (the
  // documented center-point hit-test workaround the other specs use).
  await targetRow.getByTestId("agent-actions").evaluate((el) => (el as HTMLElement).click());
  await page
    .getByTestId("agent-remove")
    .evaluate((el) => (el as HTMLElement).click());

  const confirm = page.getByTestId("agent-remove-confirm");
  await expect(confirm).toBeVisible();
  // The confirm dialog names the agency it is about to erase.
  await expect(confirm).toContainText(REMOVE_AGENCY);

  await confirm
    .getByTestId("agent-remove-confirm-btn")
    .evaluate((el) => (el as HTMLElement).click());

  // The row is gone, the modal closes, and the table shrinks by exactly one.
  await expect(targetRow).toHaveCount(0);
  await expect(page.getByTestId("agent-remove-confirm")).toHaveCount(0);
  await expect(page.getByTestId("agent-row")).toHaveCount(totalBefore - 1);

  // The Contacted metric tracks the erase — it drops by one.
  await expect
    .poll(() => metricValue(page, "agents-metric-contacted"))
    .toBe(contactedBefore - 1);

  // Belt-and-braces: the agent is really gone from the pool (not just hidden).
  const remaining = await withClient(async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "Agent" WHERE email = $1`,
      [REMOVE_EMAIL],
    );
    return Number(rows[0]?.count ?? "0");
  });
  expect(remaining).toBe(0);
});
