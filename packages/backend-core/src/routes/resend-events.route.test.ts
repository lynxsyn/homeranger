/**
 * Unit tests for POST /webhooks/resend/events. Builds a real Fastify instance,
 * injects signed/tampered requests, and asserts the route enqueues resend:event
 * with the svix-id as providerEventId. The BullMQ client is an in-memory spy.
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

const SECRET = `whsec_${Buffer.from("events-route-test-secret").toString("base64")}`;

class SpyQueueClient implements QueueClient {
  readonly calls: Array<{ name: QueueName; idempotencyKey: string; payload: unknown }> =
    [];
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
    throw new Error("not used");
  }
  async upsertScheduledJob(): Promise<void> {
    throw new Error("not used");
  }
  async getQueueDepth(): Promise<number> {
    return 0;
  }
  async close(): Promise<void> {}
}

function bounceBody(): string {
  return JSON.stringify({
    type: "email.bounced",
    created_at: new Date().toISOString(),
    data: {
      email_id: "email_b1",
      to: ["agent@example.com"],
      bounce: { type: "Permanent", subType: "General", message: "mailbox full" },
    },
  });
}

function signedHeaders(body: string, id = "evt_1"): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": signSvixPayload(body, id, ts, SECRET),
  };
}

let app: FastifyInstance;
let spy: SpyQueueClient;

beforeEach(async () => {
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  spy = new SpyQueueClient();
  _setQueueClientForTesting(spy);
  app = Fastify();
  const { registerResendEventsRoute } = await import("./resend-events.route.js");
  await registerResendEventsRoute(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  _setQueueClientForTesting(null);
  delete process.env.RESEND_WEBHOOK_SECRET;
});

describe("POST /webhooks/resend/events", () => {
  it("accepts a signed bounce (webhook-* alias headers) and enqueues resend:event (202)", async () => {
    const body = bounceBody();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/resend/events",
      headers: signedHeaders(body, "evt_bounce"),
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.name).toBe("resend:event");
    expect(spy.calls[0]!.idempotencyKey).toBe("resend:event:evt_bounce");
    const payload = spy.calls[0]!.payload as { providerEventId: string; type: string };
    expect(payload.providerEventId).toBe("evt_bounce");
    expect(payload.type).toBe("email.bounced");
  });

  it("401s a tampered body", async () => {
    const body = bounceBody();
    const headers = signedHeaders(body);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/resend/events",
      headers,
      payload: body + "x",
    });
    expect(res.statusCode).toBe(401);
    expect(spy.calls).toHaveLength(0);
  });

  it("202 no-ops an unknown event type", async () => {
    const body = JSON.stringify({ type: "email.unknown_thing", data: { email_id: "x" } });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/resend/events",
      headers: signedHeaders(body),
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(spy.calls).toHaveLength(0);
  });

  it("400s missing signature headers", async () => {
    const body = bounceBody();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/resend/events",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(spy.calls).toHaveLength(0);
  });

  it("408s a stale timestamp", async () => {
    const body = bounceBody();
    const id = "evt_stale";
    const staleTs = String(Math.floor(Date.now() / 1000) - 600);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/resend/events",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": staleTs,
        "webhook-signature": signSvixPayload(body, id, staleTs, SECRET),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(408);
    expect(spy.calls).toHaveLength(0);
  });

  it("400s non-JSON that passes the signature", async () => {
    const body = "}{ not json";
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/resend/events",
      headers: signedHeaders(body),
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(spy.calls).toHaveLength(0);
  });

  it("enqueues a complaint event", async () => {
    const body = JSON.stringify({
      type: "email.complained",
      created_at: new Date().toISOString(),
      data: { email_id: "email_c1", to: ["spam@example.com"] },
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/resend/events",
      headers: signedHeaders(body, "evt_complaint"),
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(spy.calls).toHaveLength(1);
    expect((spy.calls[0]!.payload as { type: string }).type).toBe(
      "email.complained",
    );
  });
});

describe("POST /webhooks/resend/events — secret not configured", () => {
  it("401s when RESEND_WEBHOOK_SECRET is unset (non-prod)", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const localApp = Fastify();
    const { registerResendEventsRoute } = await import(
      "./resend-events.route.js"
    );
    await registerResendEventsRoute(localApp);
    await localApp.ready();
    const body = bounceBody();
    const res = await localApp.inject({
      method: "POST",
      url: "/webhooks/resend/events",
      headers: signedHeaders(body),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    await localApp.close();
  });
});
