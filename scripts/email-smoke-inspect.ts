/**
 * smoke:inspect — the DB side of the live email smoke flow: print exactly what
 * the system GENERATED and recorded for the smoke agents (the persisted
 * outbound draft incl. bodyHtml, any inbound reply + extracted listings, and the
 * thread status). Pairs with smoke:read (what actually LANDED in the inbox).
 *
 * Read-only. Point it at any environment via DATABASE_URL (e.g. the pve1
 * port-forward, exactly like db:seed:live-smoke). Local ops tool; not deployed.
 *
 * Usage (from repo root):
 *   DATABASE_URL=... pnpm smoke:inspect              # SMOKE1 agents
 *   DATABASE_URL=... pnpm smoke:inspect --outcode ZZ9
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeOutreachBody } from "@homeranger/backend-core/lib/mailbox/outreach-body";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: resolve(repoRoot, ".env") });
loadEnv({
  path: process.env.LIVE_SMOKE_ENV_FILE ?? resolve(repoRoot, ".env.live-smoke"),
});

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function databaseHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").host || "(unset)";
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

function snippet(text: string | null | undefined, n = 200): string {
  if (!text) return "(none)";
  return text.replace(/\s+/g, " ").trim().slice(0, n);
}

function iso(date: Date | null | undefined): string {
  return date ? date.toISOString() : "—";
}

async function main(): Promise<void> {
  const outcode = (arg("--outcode") ?? "SMOKE1").toUpperCase();
  console.log(`Inspecting outcode ${outcode} on database host: ${databaseHost()}\n`);

  // Lazy import so DATABASE_URL is set before the pg adapter is constructed.
  const { prisma } = await import("@homeranger/backend-core/lib/prisma");
  try {
    const agents = await prisma.agent.findMany({
      where: { coveredOutcodes: { has: outcode } },
      orderBy: { email: "asc" },
      select: { id: true, email: true, agencyName: true, optedOut: true },
    });
    if (agents.length === 0) {
      console.log(`No agents found on outcode ${outcode}. (Has the seed run?)`);
      return;
    }

    const threads = await prisma.outreachThread.findMany({
      where: { agentId: { in: agents.map((a) => a.id) } },
      orderBy: { lastMessageAt: "desc" },
      select: {
        agentId: true,
        status: true,
        lastMessageAt: true,
        messages: {
          orderBy: { createdAt: "asc" },
          select: {
            direction: true,
            subject: true,
            bodyText: true,
            bodyHtml: true,
            sentAt: true,
            receivedAt: true,
            parsedListingIds: true,
          },
        },
      },
    });
    const threadsByAgent = new Map<string, (typeof threads)[number][]>();
    for (const thread of threads) {
      threadsByAgent.set(thread.agentId, [
        ...(threadsByAgent.get(thread.agentId) ?? []),
        thread,
      ]);
    }

    for (const agent of agents) {
      const agentThreads = threadsByAgent.get(agent.id) ?? [];
      console.log(
        `● ${agent.email}  [${agent.agencyName ?? "—"}]${agent.optedOut ? "  (OPTED OUT)" : ""}`,
      );
      if (agentThreads.length === 0) {
        console.log("    no thread yet — not contacted (Launch → Approve to send)\n");
        continue;
      }
      for (const thread of agentThreads) {
        console.log(
          `    thread ${thread.status}  (last activity ${iso(thread.lastMessageAt)}, ${thread.messages.length} message(s))`,
        );
        for (const message of thread.messages) {
          const arrow = message.direction === "outbound" ? "→ outbound" : "← inbound ";
          const when =
            message.direction === "outbound"
              ? iso(message.sentAt)
              : iso(message.receivedAt);
          const body = analyzeOutreachBody({
            text: message.bodyText,
            html: message.bodyHtml,
          });
          const listings =
            message.parsedListingIds.length > 0
              ? `  listings:[${message.parsedListingIds.length}]`
              : "";
          console.log(`      ${arrow}  "${message.subject ?? "—"}"  ${when}${listings}`);
          console.log(`         text: ${snippet(message.bodyText)}`);
          console.log(
            `         html: ${body.htmlLength} chars   em-dash: ${
              body.hasEmDash ? "PRESENT (AI tell!)" : "none"
            }   unsubscribe: ${body.hasUnsubscribe ? "yes" : "MISSING"}`,
          );
        }
      }
      console.log("");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error("smoke:inspect failed:", err);
  process.exitCode = 1;
});
