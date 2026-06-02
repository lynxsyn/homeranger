import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerOutreachUnsubscribeRoute } from "./outreach-unsubscribe.route.js";
import { signUnsubscribeToken } from "../lib/outreach/unsubscribe-token.js";
import {
  _setSuppressionEntryRepositoryForTesting,
  type SuppressionEntryRepository,
} from "../repositories/suppression-entry.repository.js";
import {
  _setAgentRepositoryForTesting,
  type AgentRepository,
} from "../repositories/agent.repository.js";
import {
  _setOutreachRepositoryForTesting,
  type OutreachRepository,
} from "../repositories/outreach.repository.js";

const EMAIL = "branch@agency.test";

function stubRepos(agentId: string | null) {
  const suppress = vi.fn().mockResolvedValue({});
  const markOptedOut = vi.fn().mockResolvedValue(undefined);
  const findByEmail = vi
    .fn()
    .mockResolvedValue(agentId ? { id: agentId, email: EMAIL } : null);
  const closeThreadsByAgent = vi.fn().mockResolvedValue(1);
  _setSuppressionEntryRepositoryForTesting({
    suppress,
    isSuppressed: vi.fn(),
  } as unknown as SuppressionEntryRepository);
  _setAgentRepositoryForTesting({
    markOptedOut,
    findByEmail,
  } as unknown as AgentRepository);
  _setOutreachRepositoryForTesting({
    closeThreadsByAgent,
  } as unknown as OutreachRepository);
  return { suppress, markOptedOut, findByEmail, closeThreadsByAgent };
}

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerOutreachUnsubscribeRoute(app);
  await app.ready();
  return app;
}

afterEach(() => {
  _setSuppressionEntryRepositoryForTesting(null);
  _setAgentRepositoryForTesting(null);
  _setOutreachRepositoryForTesting(null);
  vi.restoreAllMocks();
});

describe("POST /api/outreach/unsubscribe", () => {
  it("400s on missing email/token (no writes)", async () => {
    const repos = stubRepos("agent-1");
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/outreach/unsubscribe",
    });
    expect(res.statusCode).toBe(400);
    expect(repos.suppress).not.toHaveBeenCalled();
    await app.close();
  });

  it("400s on an invalid token (no writes)", async () => {
    const repos = stubRepos("agent-1");
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/outreach/unsubscribe?email=${encodeURIComponent(EMAIL)}&token=garbage`,
    });
    expect(res.statusCode).toBe(400);
    expect(repos.suppress).not.toHaveBeenCalled();
    expect(repos.markOptedOut).not.toHaveBeenCalled();
    await app.close();
  });

  it("200s on a valid token — suppresses, opts out, and closes threads (idempotent)", async () => {
    const repos = stubRepos("agent-1");
    const token = signUnsubscribeToken(EMAIL);
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/outreach/unsubscribe?email=${encodeURIComponent(EMAIL)}&token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(repos.suppress).toHaveBeenCalledWith(
      expect.objectContaining({ email: EMAIL, reason: "unsubscribe" }),
    );
    expect(repos.markOptedOut).toHaveBeenCalledWith(EMAIL);
    expect(repos.closeThreadsByAgent).toHaveBeenCalledWith("agent-1");
    await app.close();
  });

  it("500s (no unhandled throw) when a write fails — graceful degradation", async () => {
    const repos = stubRepos("agent-1");
    repos.suppress.mockRejectedValue(new Error("db down"));
    const token = signUnsubscribeToken(EMAIL);
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/outreach/unsubscribe?email=${encodeURIComponent(EMAIL)}&token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});
