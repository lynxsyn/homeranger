/**
 * Agent-quality backfill — re-evaluate EVERY existing Agent row with the same
 * classify gate the discovery pipeline now applies pre-upsert, and ERASE the
 * confident non-agency junk (councils, housing associations, property portals,
 * directory/PDF "agents") that predates the classifier.
 *
 * SAFETY (the whole point of running this as a gated script, not a queue job):
 *   - NEVER erase a contacted agent. `lastContactedAt != null` is a HARD SKIP —
 *     opting out doesn't un-contact them and we never want a second approach, so
 *     the correspondence (OutreachThread/OutreachMessage) must survive even for a
 *     mis-sourced junk row that was already (wrongly) emailed.
 *   - Auto-delete fires ONLY on a CONFIDENT non-agency verdict (shouldAutoDelete:
 *     !isResidentialSalesAgency && confidence >= threshold). Uncertain → KEPT.
 *   - Deterministic free filters first (isPortalEmail / isNonAgencyName) drop the
 *     unambiguous junk before any LLM spend; the LLM only judges the survivors.
 *   - DRY-RUN by default — it prints a full report and erases NOTHING. The
 *     destructive erasure is gated behind CONFIRM=1 (mirrors the live-smoke seed's
 *     LIVE_SMOKE_CONFIRM=1 gate). Re-runnable + idempotent.
 *   - Honours ANALYSIS_KILL_SWITCH: when the analysis kill-switch is ON, the LLM
 *     is skipped entirely (report-only; deterministic hits still reported, nothing
 *     erased) so a backfill can never spend or delete with analysis disabled.
 *
 * Erasure goes through `eraseAgentById` — the GDPR-complete primitive that, in one
 * transaction, deletes the Agent (cascading its OutreachThread/OutreachMessage)
 * AND purges the EmailEvent rows keyed by its email. NEVER a raw delete, and NOT
 * the bulk `deleteManyByIds` (that path does not purge EmailEvent PII).
 *
 * Run (dry-run):  pnpm --filter @homeranger/api db:classify-backfill
 * Run (erase):    CONFIRM=1 pnpm --filter @homeranger/api db:classify-backfill
 * Fake LLM:       CLASSIFY_FAKE=1 (or ANALYSIS_FAKE=1) for a network-free dry-run.
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPortalEmail,
  isNonAgencyName,
} from "@homeranger/backend-core/lib/discovery/discovery-queries";
import {
  shouldAutoDelete,
  DefaultClaudeAgentClassifier,
  type AgentClassifier,
} from "@homeranger/backend-core/lib/ai/agent-classifier.provider";
import { FakeAgentClassifier } from "@homeranger/backend-core/lib/ai/fake-agent-classifier.provider";

// Load env BEFORE importing the Prisma client (it builds the pg adapter from
// DATABASE_URL at import time). direnv/inline exports win over the file.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv({ path: resolve(repoRoot, ".env") });

/** The analysis kill-switch read — mirrors getListingAnalysisConfig exactly. */
function isAnalysisKillSwitchOn(): boolean {
  return (
    process.env.ANALYSIS_KILL_SWITCH === "1" ||
    process.env.ANALYSIS_KILL_SWITCH === "true"
  );
}

/** The decision recorded per agent for the report. */
type Decision =
  | "skip:contacted"
  | "drop:portal-email"
  | "drop:non-agency-name"
  | "skip:kill-switch"
  | "drop:confident-non-agency"
  | "keep:uncertain"
  | "keep:agency";

interface ReportRow {
  id: string;
  agencyName: string | null;
  email: string;
  kind: string;
  confidence: number | null;
  decision: Decision;
}

function databaseHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").host || "(unset)";
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main(): Promise<void> {
  const confirm = process.env.CONFIRM === "1";
  const killSwitchOn = isAnalysisKillSwitchOn();
  const host = databaseHost();
  const useFake =
    process.env.ANALYSIS_FAKE === "1" || process.env.CLASSIFY_FAKE === "1";

  const classifier: AgentClassifier = useFake
    ? new FakeAgentClassifier()
    : new DefaultClaudeAgentClassifier();

  console.log(`Agent-quality backfill target database host: ${host}`);
  console.log(
    `Mode: ${confirm ? "ERASE (CONFIRM=1)" : "DRY-RUN (report only)"}` +
      ` · classifier: ${useFake ? "fake" : classifier.getModel()}` +
      `${killSwitchOn ? " · ANALYSIS_KILL_SWITCH on → LLM skipped (report only)" : ""}`,
  );

  // Import lazily so DATABASE_URL is already in process.env when the pg adapter
  // is constructed (a static import would bind the adapter too early).
  const { agentRepository } = await import(
    "@homeranger/backend-core/repositories/agent.repository"
  );
  const { eraseAgentById } = await import(
    "@homeranger/backend-core/services/agent-removal.service"
  );
  const { prisma } = await import("@homeranger/backend-core/lib/prisma");

  try {
    await runBackfill({ agentRepository, eraseAgentById, classifier, confirm, killSwitchOn });
  } finally {
    await prisma.$disconnect();
  }
}

interface BackfillDeps {
  agentRepository: {
    list: (input: {
      includeOptedOut?: boolean;
      limit?: number;
      cursor?: string;
    }) => Promise<{
      items: Array<{
        id: string;
        agencyName: string | null;
        email: string;
        website: string | null;
        lastContactedAt: Date | null;
      }>;
      nextCursor: string | null;
    }>;
  };
  eraseAgentById: (id: string) => Promise<{ id: string }>;
  classifier: AgentClassifier;
  confirm: boolean;
  killSwitchOn: boolean;
}

async function runBackfill(deps: BackfillDeps): Promise<void> {
  const { agentRepository, eraseAgentById, classifier, confirm, killSwitchOn } =
    deps;
  const report: ReportRow[] = [];
  const eraseIds: string[] = [];

  // When the analysis kill-switch is ON, the whole backfill is REPORT-ONLY:
  // never spend on the LLM and never erase (not even deterministic hits) — a
  // backfill must not delete with analysis disabled.
  const erase = !killSwitchOn;
  const flag = (id: string): void => {
    if (erase) {
      eraseIds.push(id);
    }
  };

  // Page ALL agents (opted-out included) — a junk row may also be opted out, and
  // a backfill must see the full catalogue, not just the reachable set.
  let cursor: string | undefined;
  let scanned = 0;
  for (;;) {
    const page = await agentRepository.list({
      includeOptedOut: true,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const agent of page.items) {
      scanned += 1;

      // HARD GATE: never erase a contacted agent (their correspondence survives).
      if (agent.lastContactedAt !== null) {
        report.push(row(agent, "skip:contacted"));
        continue;
      }

      // Deterministic free filters first (no LLM spend) — reported even under the
      // kill-switch, but only flagged for erasure when erasure is enabled.
      if (isPortalEmail(agent.email)) {
        report.push(row(agent, "drop:portal-email"));
        flag(agent.id);
        continue;
      }
      if (isNonAgencyName(agent.agencyName ?? undefined)) {
        report.push(row(agent, "drop:non-agency-name"));
        flag(agent.id);
        continue;
      }

      // Kill-switch: skip the LLM entirely (report only, nothing erased).
      if (killSwitchOn) {
        report.push(row(agent, "skip:kill-switch"));
        continue;
      }

      // LLM classify the survivors. FIX-2: Agent.agencyName is nullable; coalesce
      // null → "" so a null name never poisons the prompt as the string "null".
      const verdict = await classifier.classify({
        agencyName: agent.agencyName ?? "",
        email: agent.email,
        ...(agent.website ? { websiteUrl: agent.website } : {}),
      });
      if (shouldAutoDelete(verdict)) {
        report.push(
          row(agent, "drop:confident-non-agency", verdict.kind, verdict.confidence),
        );
        flag(agent.id);
      } else if (!verdict.isResidentialSalesAgency) {
        report.push(row(agent, "keep:uncertain", verdict.kind, verdict.confidence));
      } else {
        report.push(row(agent, "keep:agency", verdict.kind, verdict.confidence));
      }
    }
    if (!page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
  }

  // ── Report (ALL agents) ─────────────────────────────────────────────────────
  console.log(`\nScanned ${scanned} agent(s):`);
  for (const r of report) {
    const conf = r.confidence === null ? "—" : r.confidence.toFixed(2);
    console.log(
      `  [${r.decision}] ${r.agencyName ?? "(no name)"} <${r.email}>` +
        ` kind=${r.kind} confidence=${conf}`,
    );
  }
  console.log(
    `\n${eraseIds.length} agent(s) flagged for erasure` +
      ` (never-contacted, confident non-agency / deterministic junk).`,
  );

  if (eraseIds.length === 0) {
    console.log("Nothing to erase.");
    return;
  }

  if (!confirm) {
    console.log(
      "\nDRY-RUN: nothing erased. Re-run with CONFIRM=1 once the report above is correct.",
    );
    return;
  }

  // ── Erase (gated) ───────────────────────────────────────────────────────────
  // One GDPR-complete erasure per flagged id (cascades OutreachThread/Message,
  // purges the EmailEvent PII keyed by email). Per-id so a single P2025 (already
  // gone in a prior run) does not abort the rest.
  let erased = 0;
  for (const id of eraseIds) {
    try {
      await eraseAgentById(id);
      erased += 1;
    } catch (err) {
      console.warn(`  ! failed to erase ${id}:`, err);
    }
  }
  console.log(`\nErased ${erased}/${eraseIds.length} agent(s).`);
}

function row(
  agent: { id: string; agencyName: string | null; email: string },
  decision: Decision,
  kind = "n/a",
  confidence: number | null = null,
): ReportRow {
  return {
    id: agent.id,
    agencyName: agent.agencyName,
    email: agent.email,
    kind,
    confidence,
    decision,
  };
}

main().catch((err: unknown) => {
  console.error("Agent-quality backfill failed:", err);
  process.exitCode = 1;
});
