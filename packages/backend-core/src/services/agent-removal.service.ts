/**
 * agent-removal.service — the GDPR-complete erasure behind agents.remove.
 *
 * The operator's ask: agents must be "removed COMPLETELY with atomic operations
 * that are GDPR compliant." Deleting the Agent row cascades its OutreachThreads +
 * OutreachMessages (FK ON DELETE CASCADE), erasing the correspondence. But the
 * EmailEvent delivery/bounce/complaint feed is keyed by the email STRING (no FK
 * to Agent), so those rows — which carry the agent's address + a full webhook
 * payload — do NOT cascade. This service erases BOTH in ONE transaction, so the
 * agent's personal data is removed completely + atomically.
 *
 * Deliberately NOT erased: SuppressionEntry. A suppression (unsubscribe / bounce
 * / complaint) is a do-not-contact record retained to honour the opt-out even
 * after the agent is erased and possibly re-discovered — the recognised
 * legitimate-interest retention documented in
 * docs/compliance/legitimate-interest-basis.md. The listings the agent sent also
 * stay (a global, still-valid catalogue — "you're dropping one agency, not the
 * hunt").
 *
 * Owns only the transaction boundary (via runTransaction); the repositories own
 * all Prisma data access.
 */
import { Prisma } from "@prisma/client";
import { runTransaction } from "../lib/prisma.js";
import { agentRepository } from "../repositories/agent.repository.js";
import { emailEventRepository } from "../repositories/email-event.repository.js";

type TransactionRunner = typeof runTransaction;
let txRunner: TransactionRunner = runTransaction;
export function _setAgentRemovalTransactionRunnerForTesting(
  runner: TransactionRunner | null,
): void {
  txRunner = runner ?? runTransaction;
}

/** The Prisma P2025 the router's NOT_FOUND mapping expects for a missing agent. */
function agentNotFound(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Agent not found", {
    code: "P2025",
    clientVersion: Prisma.prismaVersion.client,
  });
}

/**
 * COMPLETELY erase one agent: delete the Agent (cascading threads + messages) and
 * purge its EmailEvent delivery rows, atomically. Resolves the agent first so a
 * missing id throws P2025 (→ NOT_FOUND) BEFORE any write, and so the email is
 * known for the EmailEvent purge. Echoes `{ id }`.
 */
export async function eraseAgentById(agentId: string): Promise<{ id: string }> {
  const agent = await agentRepository.getById(agentId);
  if (!agent) {
    throw agentNotFound();
  }
  await txRunner(async (tx) => {
    await agentRepository.deleteById(agentId, tx);
    await emailEventRepository.deleteByEmails([agent.email], tx);
  });
  return { id: agentId };
}
