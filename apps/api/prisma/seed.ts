/**
 * Idempotent E2E / dev seed for the M3 listings table.
 *
 * Upserts the shared fixtures via `listingRepository.upsertByAddress` (keyed on
 * `addressNormalized`, so re-running is a no-op refresh — safe under Playwright
 * `reuseExistingServer`). Run via `pnpm --filter @homeranger/api db:seed`
 * (`tsx prisma/seed.ts`), folded into the E2E api webServer command before the
 * server boots.
 *
 * The fixture module is the single source of truth shared with the spec; the
 * relative import carries `.js` because apps/api is module=Node16.
 */
import {
  listingRepository,
  searchProfileRepository,
} from "@homeranger/backend-core";
import { prisma } from "@homeranger/backend-core/lib/prisma";
import { LISTING_FIXTURES } from "../../../e2e/fixtures/listings.fixture.js";

async function main(): Promise<void> {
  // Clear the operator's saved ("interested") listings so the listings E2E
  // bookmark golden path starts from a clean interest-bar even on a local
  // reuseExistingServer re-run (the SavedListing overlay is operator-namespaced,
  // userId NULL, in E2E's dev bypass). Mirrors the account-menu identity reset.
  await prisma.savedListing.deleteMany({ where: { userId: null } });

  for (const fixture of LISTING_FIXTURES) {
    await listingRepository.upsertByAddress({
      addressNormalized: fixture.addressNormalized,
      postcode: fixture.postcode,
      outcode: fixture.outcode,
      pricePence: fixture.pricePence,
      bedrooms: fixture.bedrooms,
      tenure: null,
      propertyType: null,
      epcRating: null,
      listingStatus: fixture.listingStatus,
      isPreMarket: fixture.isPreMarket,
      listingUrl: fixture.listingUrl,
      primarySource: fixture.primarySource,
    });
  }

  // M5: seed the single SearchProfile so the AI-analysis E2E has preferences to
  // match against. Empty outcodes → the preference recompute recalls every
  // embedded (analysed) listing, not just one area. Idempotent (singleton row).
  await searchProfileRepository.update({
    freeTextPreferences:
      "A bright, modern flat with good natural light and some outdoor space.",
    outcodes: [],
  });

  // PR1: seed a small demo agent pool so the /agents screen (+ its E2E) has data
  // with STATUS VARIETY (one replied, one awaiting, one queued, one opted out).
  // The status is derived server-side from each agent's optedOut flag + its
  // latest non-closed OutreachThread, so we set the thread status explicitly.
  //
  // Outcode choice: the agents cover the SE1/SE16 London patch (so agents.spec's
  // "View agents" drill-in from a Bermondsey search resolves a non-empty subset)
  // plus a DEDICATED `DEMO1` tag. The search golden-path spec keys SE1/SE16 on
  // homes (listing-row), never on AGENT counts, and the launch spec uses the
  // synthetic ZZ7/ZZ8 (discovery-created, cleaned by outcode), so seeding agents
  // into SE1/SE16/DEMO1 cannot collide with any existing agent-count assertion or
  // be swept by the launch spec's per-outcode cleanup.
  const DEMO_OUTCODES = ["SE1", "SE16", "DEMO1"];
  const demoAgents = [
    {
      email: "hello@demo-replied.co.uk",
      agencyName: "Demo Replied Estates",
      threadStatus: "replied" as const,
      lastContactedAt: new Date("2026-05-20T09:00:00.000Z"),
    },
    {
      email: "hello@demo-awaiting.co.uk",
      agencyName: "Demo Awaiting Lettings",
      threadStatus: "awaiting_reply" as const,
      lastContactedAt: new Date("2026-05-25T09:00:00.000Z"),
    },
    {
      email: "hello@demo-queued.co.uk",
      agencyName: "Demo Queued Homes",
      // `active` thread → the design "queued" status (first send pending).
      threadStatus: "active" as const,
      lastContactedAt: null,
    },
    {
      email: "hello@demo-optedout.co.uk",
      agencyName: "Demo Opted-out Property",
      // optedOut takes precedence; no open thread needed.
      threadStatus: null,
      optedOut: true,
      lastContactedAt: new Date("2026-04-10T09:00:00.000Z"),
    },
  ];

  for (const demo of demoAgents) {
    const agent = await prisma.agent.upsert({
      where: { email: demo.email },
      create: {
        email: demo.email,
        agencyName: demo.agencyName,
        mailboxType: "corporate_subscriber",
        coveredOutcodes: DEMO_OUTCODES,
        lastContactedAt: demo.lastContactedAt,
        optedOut: demo.optedOut ?? false,
      },
      update: {
        agencyName: demo.agencyName,
        mailboxType: "corporate_subscriber",
        coveredOutcodes: DEMO_OUTCODES,
        lastContactedAt: demo.lastContactedAt,
        optedOut: demo.optedOut ?? false,
      },
      select: { id: true },
    });
    // Idempotent thread state: clear this demo agent's threads, then create the
    // one that yields the intended status (re-running the seed never piles up).
    await prisma.outreachThread.deleteMany({ where: { agentId: agent.id } });
    if (demo.threadStatus) {
      await prisma.outreachThread.create({
        data: {
          agentId: agent.id,
          subject: "Off-market enquiry",
          status: demo.threadStatus,
          lastMessageAt: demo.lastContactedAt,
        },
      });
    }
  }

  console.log(
    `Seeded ${LISTING_FIXTURES.length} listing fixtures + the search profile` +
      ` + ${demoAgents.length} demo agents (outcodes ${DEMO_OUTCODES.join(", ")}).`,
  );
}

main()
  .catch((err: unknown) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
