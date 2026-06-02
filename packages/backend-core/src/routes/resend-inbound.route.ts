/**
 * POST /webhooks/resend/inbound — Resend inbound-parse (`email.received`).
 *
 * Mirrors the doxus-web email-ingestion.route.ts SHAPE:
 *   raw-buffer body parser (so the bytes survive for signature verification)
 *   → Svix signature prehandler (Node crypto, no SDK)
 *   → JSON.parse + Zod validation of the body
 *   → idempotency key `resend:inbound:<email_id>`
 *   → enqueue on the `outreach:inbound` BullMQ queue
 *   → immediate 202.
 *
 * DIVERGENCE FROM DOXUS (load-bearing): Resend's inbound webhook carries
 * METADATA ONLY (from/to/subject + attachment list), NOT the body text/html or
 * attachment bytes. The `outreach:inbound` worker fetches the full message +
 * attachment content from the Resend Received-Emails / Attachments API using
 * `email_id`. So this route enqueues only the metadata; the worker hydrates.
 *
 * Signature: Resend signs with Svix (`svix-id`/`svix-timestamp`/`svix-signature`
 * or the `webhook-*` aliases; secret `whsec_…` in RESEND_INBOUND_WEBHOOK_SECRET).
 * Verified with lib/webhooks/svix-signature.ts. The route returns RAW HTTP
 * status (NOT TRPCError) — webhooks are not tRPC procedures.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  extractSvixHeaders,
  verifySvixSignature,
} from "../lib/webhooks/svix-signature.js";
import { enqueueInboundEmail } from "../lib/queue/queue-client.js";

function loadInboundSecret(): string | null {
  const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error(
      "RESEND_INBOUND_WEBHOOK_SECRET environment variable is required in production",
    );
  }
  return secret ?? null;
}

/** Resend `email.received` webhook — metadata only (body fetched by worker). */
const inboundAttachmentSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(255),
  content_disposition: z.string().optional(),
  content_id: z.string().nullable().optional(),
});

export const resendInboundEventSchema = z.object({
  type: z.literal("email.received"),
  created_at: z.string(),
  data: z.object({
    email_id: z.string().min(1),
    created_at: z.string().optional(),
    from: z.string().min(1),
    to: z.array(z.string()).default([]),
    cc: z.array(z.string()).default([]),
    bcc: z.array(z.string()).default([]),
    message_id: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    attachments: z.array(inboundAttachmentSchema).default([]),
  }),
});

export type ResendInboundEvent = z.infer<typeof resendInboundEventSchema>;

function getRawBody(request: FastifyRequest): Buffer | null {
  return Buffer.isBuffer(request.body) ? request.body : null;
}

export async function registerResendInboundRoute(
  fastify: FastifyInstance,
): Promise<void> {
  const inboundSecret = loadInboundSecret();

  await fastify.register(async (route) => {
    route.removeContentTypeParser("application/json");
    route.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );

    route.post(
      "/webhooks/resend/inbound",
      async (request, reply: FastifyReply) => {
        if (!inboundSecret) {
          request.log.error("Resend inbound webhook secret not configured");
          return reply
            .code(401)
            .send({ error: "inbound webhook receiver not configured" });
        }

        const rawBody = getRawBody(request);
        if (!rawBody) {
          return reply.code(400).send({ error: "Invalid request body" });
        }

        const verify = verifySvixSignature(
          rawBody,
          extractSvixHeaders(request.headers),
          inboundSecret,
        );
        if (!verify.ok) {
          request.log.warn(
            { reason: verify.reason },
            "Resend inbound signature verification failed",
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

        const parsed = resendInboundEventSchema.safeParse(json);
        if (!parsed.success) {
          // A non-`email.received` type delivered here is ignored (202 no-op)
          // so Resend stops retrying; a malformed `email.received` is a 400.
          if (
            typeof json === "object" &&
            json !== null &&
            "type" in json &&
            (json as { type?: unknown }).type !== "email.received"
          ) {
            return reply.code(202).send({ ok: true, ignored: true });
          }
          return reply
            .code(400)
            .send({ error: "Invalid payload", issues: parsed.error.flatten() });
        }

        // Enqueue the METADATA only — the worker hydrates body + attachments.
        // Idempotency key: a redelivered email_id is a no-op enqueue because
        // BullMQ rejects a duplicate jobId (queue-client maps `:`→`__`).
        await enqueueInboundEmail({
          idempotencyKey: `resend:inbound:${parsed.data.data.email_id}`,
          payload: parsed.data.data,
        });

        return reply.code(202).send({ ok: true });
      },
    );
  });
}
