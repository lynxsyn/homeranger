/**
 * Unit tests for POST /webhooks/resend/inbound (M4 test plan, Unit: signature
 * prehandler — valid HMAC → enqueue + 202; tampered → 401; duplicate email_id →
 * idempotent enqueue). Builds a real Fastify instance, registers the route, and
 * injects signed/tampered/duplicate requests. The BullMQ client is swapped for
 * an in-memory enqueue spy via `_setQueueClientForTesting` — no Redis.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signSvixPayload } from "../lib/webhooks/svix-signature.js";
import {
  _setQueueClientForTesting,
  type EnqueueInput,
  type QueueClient,
} from "../lib/queue/queue-client.js";
import type { JobPayloadByType, QueueName } from "../lib/queue/queue-config.js";

const SECRET = `whsec_${Buffer.from("inbound-route-test-secret").toString("base64")}`;

interface Enqueued {
  name: QueueName;
  idempotencyKey: string;
  payload: unknown;
}

class SpyQueueClient implements QueueClient {
  readonly calls: Enqueued[] = [];
  async enqueue<N extends QueueName>(
    name: N,
    input: EnqueueInput<JobPayloadByType[N]>,
  ): Promise<void> {
    this.calls.push({
      name,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
    });
  }
  registerProcessor(): void {
    throw new Error("not used in route tests");
  }
  async getQueueDepth(): Promise<number> {
    return 0;
  }
  async close(): Promise<void> {}
}

function makeInboundBody(emailId = "email_abc"): string {
  return JSON.stringify({
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: emailId,
      from: "agent@example.com",
      to: ["inbox@homescout.app"],
      subject: "New listing: 7 Test Road SW1A 1AA",
      attachments: [],
    },
  });
}

function signedHeaders(body: string, id = "msg_1"): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": ts,
    "svix-signature": signSvixPayload(body, id, ts, SECRET),
  };
}

let app: FastifyInstance;
let spy: SpyQueueClient;

beforeEach(async () => {
  process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
  spy = new SpyQueueClient();
  _setQueueClientForTesting(spy);
  app = Fastify();
  const { registerResendInboundRoute } = await import("./resend-inbound.route.js");
  await registerResendInboundRoute(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  _setQueueClientForTesting(null);
  delete process.env.RESEND_INBOUND_WEBHOOK_SECRET;
});

describe("POST /webhooks/resend/inbound", () => {
  it("accepts a correctly signed email.received and enqueues outreach:inbound (202)", async () => {
    const body = makeInboundBody("email_abc");
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/resend/inbound",
      headers: signedHeaders(body),
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.name).toBe("outreach:inbound");
    expect(spy.calls[0]!.idempotencyKey).toBe("resend:inbound:email_abc");
    expect((spy.calls[0]!.payload as { email_id: string }).email_id).toBe(
      "email_abc",
    );
  });

  it("rejects a tampered body with 401 and does not enqueue", async () => {
    const body = makeInboundBody("email_tamper");
    const headers = signedHeaders(body);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/resend/inbound",
      headers,
      payload: body + " ", // mutate after signing
    });

    expect(res.statusCode).toBe(401);
    expect(spy.calls).toHaveLength(0);
  });

  it("400s on missing signature headers", async () => {
    const body = makeInboundBody();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/resend/inbound",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(spy.calls).toHaveLength(0);
  });

  it("uses the same idempotency key for a duplicate email_id (BullMQ dedupes)", async () => {
    const body = makeInboundBody("email_dup");
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/resend/inbound",
        headers: signedHeaders(body, `msg_${i}`),
        payload: body,
      });
      expect(res.statusCode).toBe(202);
    }
    // Both enqueue with the SAME logical key — BullMQ collapses on jobId in prod.
    expect(spy.calls.map((c) => c.idempotencyKey)).toEqual([
      "resend:inbound:email_dup",
      "resend:inbound:email_dup",
    ]);
  });

  it("202 no-ops a non-email.received type delivered to this endpoint", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: {} });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/resend/inbound",
      headers: signedHeaders(body),
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(spy.calls).toHaveLength(0);
  });

  it("408s a stale timestamp (replay window exceeded)", async () => {
    const body = makeInboundBody("email_stale");
    const id = "msg_stale";
    const staleTs = String(Math.floor(Date.now() / 1000) - 600); // 10 min old
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/resend/inbound",
      headers: {
        "content-type": "application/json",
        "svix-id": id,
        "svix-timestamp": staleTs,
        "svix-signature": signSvixPayload(body, id, staleTs, SECRET),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(408);
    expect(spy.calls).toHaveLength(0);
  });

  it("400s a malformed email.received body", async () => {
    // type === email.received but missing the required data fields.
    const body = JSON.stringify({ type: "email.received", created_at: "x", data: {} });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/resend/inbound",
      headers: signedHeaders(body),
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(spy.calls).toHaveLength(0);
  });

  it("400s non-JSON that still passes the signature (invalid JSON branch)", async () => {
    const body = "not-json-at-all";
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/resend/inbound",
      headers: signedHeaders(body),
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(spy.calls).toHaveLength(0);
  });
});

describe("POST /webhooks/resend/inbound — secret not configured", () => {
  it("401s when RESEND_INBOUND_WEBHOOK_SECRET is unset (non-prod)", async () => {
    delete process.env.RESEND_INBOUND_WEBHOOK_SECRET;
    const localApp = Fastify();
    const { registerResendInboundRoute } = await import(
      "./resend-inbound.route.js"
    );
    await registerResendInboundRoute(localApp);
    await localApp.ready();
    const body = makeInboundBody();
    const res = await localApp.inject({
      method: "POST",
      url: "/webhooks/resend/inbound",
      headers: signedHeaders(body),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    await localApp.close();
  });
});
