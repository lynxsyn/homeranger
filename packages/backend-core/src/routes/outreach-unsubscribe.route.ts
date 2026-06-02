/**
 * One-click unsubscribe (M6 AC#5, RFC 8058). The outbound email carries
 * `List-Unsubscribe: <…/api/outreach/unsubscribe?email=&token=>` +
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; the MUA POSTs here with
 * no user session. This route:
 *   - is UNAUTHENTICATED (registered before the tRPC plugin in main.ts),
 *   - verifies the HMAC token CONSTANT-TIME + email-bound (a token for agent A
 *     cannot suppress agent B),
 *   - is IDEMPOTENT (suppress is an upsert; markOptedOut/closeThreads are no-ops
 *     on replay) → a pre-fetched or double-clicked POST returns 200,
 *   - writes SuppressionEntry(unsubscribe) + Agent.optedOut + closes open threads
 *     (AC#4 → closed), so ALL future sends are short-circuited by the guard.
 * GET is also accepted (a human clicking the link in a plain-text client).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { suppressionEntryRepository } from "../repositories/suppression-entry.repository.js";
import { agentRepository } from "../repositories/agent.repository.js";
import { outreachRepository } from "../repositories/outreach.repository.js";
import { verifyUnsubscribeToken } from "../lib/outreach/unsubscribe-token.js";

async function handleUnsubscribe(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const query = request.query as { email?: string; token?: string };
  const email = query.email;
  const token = query.token;
  if (!email || !token) {
    return reply.code(400).send({ error: "Missing email or token" });
  }
  if (!verifyUnsubscribeToken(email, token)) {
    // Don't log the token (a bearer credential) or the email (PII).
    request.log.warn("outreach unsubscribe: invalid token");
    return reply.code(400).send({ error: "Invalid token" });
  }

  await suppressionEntryRepository.suppress({
    email,
    reason: "unsubscribe",
    note: "one-click unsubscribe (RFC 8058)",
  });
  await agentRepository.markOptedOut(email);
  const agent = await agentRepository.findByEmail(email);
  if (agent) {
    await outreachRepository.closeThreadsByAgent(agent.id);
  }

  return reply.code(200).send({ ok: true, unsubscribed: true });
}

export async function registerOutreachUnsubscribeRoute(
  fastify: FastifyInstance,
): Promise<void> {
  // RFC 8058 one-click is a POST; GET supports a human clicking a plain-text link.
  fastify.post("/api/outreach/unsubscribe", handleUnsubscribe);
  fastify.get("/api/outreach/unsubscribe", handleUnsubscribe);
}
