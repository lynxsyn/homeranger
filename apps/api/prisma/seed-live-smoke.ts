/**
 * Live-email smoke seed — provisions a dummy operator search + a set of REAL
 * mailboxes you own as `corporate_subscriber` agents, so the send → receive →
 * reply round-trip can be exercised end-to-end against a deployed environment
 * (Resend actually delivers; the homeranger.app inbound webhook links replies).
 *
 * This is SEPARATE from prisma/seed.ts on purpose:
 *   - seed.ts is the deterministic E2E/dev seed (runs under OUTREACH_FAKE=1, no
 *     real email) and must stay free of personal addresses + non-determinism.
 *   - this script is a manual ops tool. The addresses come from the environment
 *     (LIVE_SMOKE_AGENT_EMAILS, ideally via a gitignored .env.live-smoke), so no
 *     personal mailbox is ever committed.
 *
 * Run:  pnpm --filter @homeranger/api db:seed:live-smoke
 * See:  docs/runbooks/live-email-smoke.md (how to point at pve1 + drive the test)
 *
 * Idempotent for non-concurrent runs: the search is found-or-updated by
 * (operator namespace, name) — Search has no unique(userId, name), so two truly
 * simultaneous FIRST runs could create duplicates; a single operator re-running
 * serially is a safe refresh. Each agent is upserted by its unique email.
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLiveSmokePlan,
  SMOKE_SCENARIOS,
} from "@homeranger/backend-core/lib/live-smoke/live-smoke-plan";

// Load env BEFORE importing the Prisma client (it builds the pg adapter from
// DATABASE_URL at import time). Neither file overrides an already-set var, so
// inline exports + direnv win; the gitignored .env.live-smoke supplies the
// LIVE_SMOKE_* keys (and optionally DATABASE_URL for a remote target).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv({ path: resolve(repoRoot, ".env") });
loadEnv({
  path: process.env.LIVE_SMOKE_ENV_FILE ?? resolve(repoRoot, ".env.live-smoke"),
});

function databaseHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").host || "(unset)";
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main(): Promise<void> {
  // Build (+ validate) the plan first — a missing/blank LIVE_SMOKE_AGENT_EMAILS
  // throws here, before any DB connection, so a no-config run can never write.
  const plan = buildLiveSmokePlan(process.env);

  // This script ALWAYS writes real, sendable corporate_subscriber agents that
  // point at real mailboxes — a privileged write regardless of target. So show
  // the exact target host + recipients and require an explicit confirm. A
  // localhost heuristic would be FALSE safety: the documented pve1 path is a
  // localhost port-forward, and a forgotten kubectl context would otherwise
  // write to prod silently.
  const host = databaseHost();
  console.log(`Live-smoke seed target database host: ${host}`);
  console.log(
    `About to write ${plan.agents.length} corporate_subscriber agent(s):`,
  );
  for (const agent of plan.agents) {
    console.log(`  • ${agent.email}  [${agent.scenario}]`);
  }
  if (process.env.LIVE_SMOKE_CONFIRM !== "1") {
    console.error(
      "\nRefusing to write without confirmation. Re-run with LIVE_SMOKE_CONFIRM=1 once the target host + recipients above are correct.",
    );
    process.exitCode = 1;
    return;
  }

  // Import lazily so DATABASE_URL is already in process.env when the pg adapter
  // is constructed (a static import would bind the adapter too early). NOTE:
  // keep live-smoke-plan import-free of prisma or this lazy load stops working.
  const { prisma } = await import("@homeranger/backend-core/lib/prisma");

  try {
    // Operator search (userId NULL = the operator namespace the outreach engine
    // reads). Found-or-updated by name so the synthetic outcode is written
    // directly (NOT resolved from `location` the way searchRepository.create
    // would), keeping the search ⇄ agents link on the seeded outcode.
    const existing = await prisma.search.findFirst({
      where: { userId: null, name: plan.search.name },
      select: { id: true },
    });
    const searchData = {
      location: plan.search.location,
      outcodes: plan.search.outcodes,
      keywords: plan.search.keywords,
      status: plan.search.status,
    };
    const search = existing
      ? await prisma.search.update({
          where: { id: existing.id },
          data: searchData,
          select: { id: true, name: true },
        })
      : await prisma.search.create({
          data: { userId: null, name: plan.search.name, ...searchData },
          select: { id: true, name: true },
        });

    // One Agent per owned mailbox, keyed on the unique email (idempotent). Reset
    // optedOut=false on every run so a prior STOP-scenario test can be re-run
    // (NOTE: a STOP/unsubscribe also writes a SuppressionEntry, which this seed
    // does NOT clear — remove it manually to re-test the opt-out path).
    for (const agent of plan.agents) {
      await prisma.agent.upsert({
        where: { email: agent.email },
        create: {
          email: agent.email,
          agencyName: agent.agencyName,
          mailboxType: agent.mailboxType,
          coveredOutcodes: agent.coveredOutcodes,
          optedOut: agent.optedOut,
        },
        update: {
          agencyName: agent.agencyName,
          mailboxType: agent.mailboxType,
          coveredOutcodes: agent.coveredOutcodes,
          optedOut: agent.optedOut,
        },
      });
    }

    console.log(
      `\nSeeded operator search "${search.name}" (id ${search.id}) on outcode ${plan.search.outcodes.join(
        ", ",
      )}.`,
    );
    console.log(`Seeded ${plan.agents.length} corporate_subscriber agent(s):`);
    for (const agent of plan.agents) {
      const scenario = SMOKE_SCENARIOS.find((s) => s.id === agent.scenario);
      console.log(
        `  • ${agent.email}  [${agent.scenario}]\n      ${scenario?.instruction ?? ""}`,
      );
    }

    if (plan.warnings.length > 0) {
      console.warn("\nWarnings:");
      for (const warning of plan.warnings) {
        console.warn(`  ! ${warning}`);
      }
    }

    console.log(
      `\nNext: open /searches → "${search.name}" → Launch → the review modal lists these agents → Approve & send.` +
        "\nReplies land at the homeranger.app inbound webhook and advance each thread (awaiting_reply → replied/closed).",
    );
    console.log(
      `\nCleanup later (psql): DELETE FROM "Search" WHERE "userId" IS NULL AND name = '${search.name}';` +
        ` plus the agents on outcode ${plan.search.outcodes.join(
          ", ",
        )} — see docs/runbooks/live-email-smoke.md.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error("Live-smoke seed failed:", err);
  process.exitCode = 1;
});
