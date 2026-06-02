/**
 * POST /webhooks/resend/events — Resend delivery/bounce/complaint feed.
 *
 * Same raw-buffer + Svix-signature + Zod + idempotency + 202 SHAPE as the
 * inbound route, but a DIFFERENT secret (RESEND_WEBHOOK_SECRET — Resend issues
 * one signing secret per webhook endpoint) and a DIFFERENT payload (the event
 * envelope `{ type, created_at, data }`).
 *
 * The route ENQUEUES `resend:event` with the Svix `svix-id` as the
 * `providerEventId` idempotency anchor. The `outreach`/`resend:event` worker
 * (apps/processor) consumes it and calls `emailEventService.ingestEvent`, which
 * persists an idempotent `EmailEvent` row and suppresses on hard bounce / spam
 * complaint. The EmailEvent unique on `providerEventId` means a redelivered
 * webhook is a no-op even though the route enqueues each time.
 *
 * Event types (Resend → normalised EmailEventType — see email-event.service.ts):
 *   email.delivered → delivered, email.bounced → bounced (→ hard_bounce
 *   suppression when bounce.type === "Permanent"), email.complained →
 *   complained (→ spam_complaint), email.opened → opened, email.clicked →
 *   clicked, email.delivery_delayed → deferred, email.failed → failed,
 *   email.sent → no-op.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  extractSvixHeaders,
  verifySvixSignature,
} from "../lib/webhooks/svix-signature.js";
import { enqueueResendEvent } from "../lib/queue/queue-client.js";

function loadEventsSecret(): string | null {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error(
      "RESEND_WEBHOOK_SECRET environment variable is required in production",
    );
  }
  return secret ?? null;
}

const RESEND_EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.opened",
  "email.clicked",
  "email.failed",
] as const;

export const resendEventSchema = z.object({
  type: z.enum(RESEND_EVENT_TYPES),
  created_at: z.string().optional(),
  data: z.object({
    email_id: z.string().min(1),
    from: z.string().optional(),
    to: z.array(z.string()).default([]),
    subject: z.string().nullable().optional(),
    bounce: z
      .object({
        message: z.string().optional(),
        // Resend: "Permanent" (hard) | "Transient" (soft) | "Undetermined".
        type: z.string().optional(),
        subType: z.string().optional(),
      })
      .optional(),
  }),
});

export type ResendEvent = z.infer<typeof resendEventSchema>;

function getRawBody(request: FastifyRequest): Buffer | null {
  return Buffer.isBuffer(request.body) ? request.body : null;
}

export async function registerResendEventsRoute(
  fastify: FastifyInstance,
): Promise<void> {
  const eventsSecret = loadEventsSecret();

  await fastify.register(async (route) => {
    route.removeContentTypeParser("application/json");
    route.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );

    route.post(
      "/webhooks/resend/events",
      async (request, reply: FastifyReply) => {
        if (!eventsSecret) {
          request.log.error("Resend events webhook secret not configured");
          return reply
            .code(401)
            .send({ error: "events webhook receiver not configured" });
        }

        const rawBody = getRawBody(request);
        if (!rawBody) {
          return reply.code(400).send({ error: "Invalid request body" });
        }

        const svixHeaders = extractSvixHeaders(request.headers);
        const verify = verifySvixSignature(rawBody, svixHeaders, eventsSecret);
        if (!verify.ok) {
          request.log.warn(
            { reason: verify.reason },
            "Resend events signature verification failed",
          );
          if (
            verify.reason === "missing_headers" ||
            verify.reason === "invalid_timestamp"
          ) {
            return reply.code(400).send({ error: "Invalid signature headers" });
          }
          if (verify.reason === "stale_timestamp") {
            return reply.code(408).send({ error: "Request timestamp expired" });
          }
          return reply.code(401).send({ error: "Unauthorized" });
        }

        let json: unknown;
        try {
          json = JSON.parse(rawBody.toString("utf8")) as unknown;
        } catch {
          return reply.code(400).send({ error: "Invalid JSON" });
        }

        const parsed = resendEventSchema.safeParse(json);
        if (!parsed.success) {
          // Unknown event type → 202 no-op so Resend stops retrying.
          return reply.code(202).send({ ok: true, ignored: true });
        }

        // providerEventId is the svix-id (stable per-delivery id); the
        // EmailEvent unique constraint dedupes a redelivery downstream. Fall
        // back to a composite id when (unexpectedly) absent post-verify.
        const providerEventId =
          svixHeaders.id ??
          `${parsed.data.data.email_id}:${parsed.data.type}`;

        await enqueueResendEvent({
          idempotencyKey: `resend:event:${providerEventId}`,
          payload: {
            providerEventId,
            type: parsed.data.type,
            ...(parsed.data.created_at !== undefined
              ? { created_at: parsed.data.created_at }
              : {}),
            data: parsed.data.data,
          },
        });

        return reply.code(202).send({ ok: true });
      },
    );
  });
}
