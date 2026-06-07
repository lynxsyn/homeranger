/**
 * verify:agents — one-off deliverability backfill for the EXISTING agent pool
 * (discovered before email verification existed). Probes each agent's email
 * (MX + SMTP RCPT, no message sent) and records the verdict, so the
 * ComplianceGuard blocks confirmed-dead addresses (the ~30% hard-bounce rate on
 * scraped info@/contact@ addresses motivated the whole feature).
 *
 * Run AFTER the email-verification migration is deployed, against prod via a
 * DATABASE_URL port-forward (exactly like db:seed:live-smoke). Needs outbound
 * TCP :25 — run it from a host that allows it (the cluster does, via the
 * processor NetworkPolicy egress; a home ISP may block 25). Leave EMAIL_VERIFY_FAKE
 * UNSET so the REAL SMTP probe runs (set it to 1 only to smoke-test the wiring).
 *
 * Usage (from repo root):
 *   DATABASE_URL=... pnpm verify:agents             # probe + WRITE the verdicts
 *   DATABASE_URL=... DRY_RUN=1 pnpm verify:agents   # probe + print only, no write
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: resolve(repoRoot, ".env") });

const DRY_RUN = process.env.DRY_RUN === "1";
const CONCURRENCY =
  Number.parseInt(process.env.VERIFY_CONCURRENCY ?? "8", 10) || 8;

function databaseHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").host || "(unset)";
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main(): Promise<void> {
  // Lazy import AFTER dotenv so the Prisma pg adapter binds the right DATABASE_URL.
  const { agentRepository } = await import(
    "@homeranger/backend-core/repositories/agent.repository"
  );
  const { getEmailVerifier } = await import(
    "@homeranger/backend-core/lib/email/email-verifier"
  );

  const verifier = getEmailVerifier();
  const agents = await agentRepository.findAllForVerification();
  console.log(
    `verify:agents → ${agents.length} agents on ${databaseHost()} ` +
      `(dryRun=${DRY_RUN}, concurrency=${CONCURRENCY})`,
  );

  const tally = { deliverable: 0, undeliverable: 0, unknown: 0 };
  let done = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < agents.length) {
      const agent = agents[cursor];
      cursor += 1;
      if (!agent) {
        break;
      }
      const status = await verifier.verify(agent.email);
      tally[status] += 1;
      if (!DRY_RUN) {
        await agentRepository.setEmailVerifyStatus(agent.id, status, new Date());
      }
      done += 1;
      if (status === "undeliverable") {
        console.log(`  undeliverable: ${agent.email}`);
      }
      if (done % 25 === 0) {
        console.log(`  ...${done}/${agents.length}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, agents.length || 1) }, worker),
  );

  console.log(
    `DONE: deliverable=${tally.deliverable} undeliverable=${tally.undeliverable} ` +
      `unknown=${tally.unknown}${DRY_RUN ? " (DRY RUN — no writes)" : ""}`,
  );
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
