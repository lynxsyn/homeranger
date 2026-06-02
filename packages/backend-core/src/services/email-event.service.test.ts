/**
 * Unit tests for EmailEventService (M4 test plan, Unit/Integration: bounce →
 * EmailEvent + SuppressionEntry; type normalisation; idempotent). Fakes the
 * EmailEvent + SuppressionEntry repositories — no DB.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DefaultEmailEventService,
  normaliseResendEventType,
  type ResendEventInput,
} from "./email-event.service.js";
import type {
  EmailEventRecord,
  RecordEmailEventInput,
  RecordEmailEventResult,
} from "../repositories/email-event.repository.js";
import type {
  SuppressInput,
  SuppressionEntryRecord,
} from "../repositories/suppression-entry.repository.js";

function fakeEmailEventRepo(opts: { created?: boolean } = {}) {
  const recorded: RecordEmailEventInput[] = [];
  const repo = {
    recorded,
    async recordOrIgnore(
      input: RecordEmailEventInput,
    ): Promise<RecordEmailEventResult> {
      recorded.push(input);
      const event: EmailEventRecord = {
        id: "evt-row-1",
        providerEventId: input.providerEventId,
        messageId: input.messageId,
        email: input.email,
        eventType: input.eventType,
        payload: {},
        occurredAt: input.occurredAt,
        createdAt: new Date(),
      };
      return { event, created: opts.created ?? true };
    },
    async findByProviderEventId(): Promise<EmailEventRecord | null> {
      return null;
    },
  };
  return repo as unknown as import("../repositories/email-event.repository.js").EmailEventRepository & {
    recorded: RecordEmailEventInput[];
  };
}

function fakeSuppressionRepo() {
  const suppressed: SuppressInput[] = [];
  const repo = {
    suppressed,
    async suppress(input: SuppressInput): Promise<SuppressionEntryRecord> {
      suppressed.push(input);
      return {
        id: "sup-1",
        email: input.email,
        reason: input.reason,
        note: input.note ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
    async isSuppressed(): Promise<boolean> {
      return false;
    },
  };
  return repo as unknown as import("../repositories/suppression-entry.repository.js").SuppressionEntryRepository & {
    suppressed: SuppressInput[];
  };
}

function bounceEvent(type = "Permanent"): ResendEventInput {
  return {
    providerEventId: "evt_b1",
    type: "email.bounced",
    data: {
      email_id: "email_1",
      to: ["Agent@Example.com"],
      bounce: { type, message: "mailbox full" },
    },
  };
}

describe("normaliseResendEventType", () => {
  it("maps Resend types to the EmailEventType enum", () => {
    expect(normaliseResendEventType("email.delivered")).toBe("delivered");
    expect(normaliseResendEventType("email.bounced")).toBe("bounced");
    expect(normaliseResendEventType("email.complained")).toBe("complained");
    expect(normaliseResendEventType("email.delivery_delayed")).toBe("deferred");
    expect(normaliseResendEventType("email.failed")).toBe("failed");
  });

  it("returns null for email.sent (no homescout EmailEventType)", () => {
    expect(normaliseResendEventType("email.sent")).toBeNull();
  });
});

describe("EmailEventService.ingestEvent", () => {
  it("persists a hard bounce and suppresses the (lower-cased) address (hard_bounce)", async () => {
    const events = fakeEmailEventRepo({ created: true });
    const suppress = fakeSuppressionRepo();
    const svc = new DefaultEmailEventService({
      emailEventRepository: events,
      suppressionEntryRepository: suppress,
    });

    const result = await svc.ingestEvent(bounceEvent("Permanent"));

    expect(result.created).toBe(true);
    expect(result.eventType).toBe("bounced");
    expect(result.suppressed).toBe(true);
    expect(events.recorded[0]!.email).toBe("agent@example.com");
    expect(suppress.suppressed).toEqual([
      { email: "agent@example.com", reason: "hard_bounce", note: "mailbox full" },
    ]);
  });

  it("does NOT suppress a soft (Transient) bounce", async () => {
    const events = fakeEmailEventRepo({ created: true });
    const suppress = fakeSuppressionRepo();
    const svc = new DefaultEmailEventService({
      emailEventRepository: events,
      suppressionEntryRepository: suppress,
    });

    const result = await svc.ingestEvent(bounceEvent("Transient"));

    expect(result.created).toBe(true);
    expect(result.suppressed).toBe(false);
    expect(suppress.suppressed).toHaveLength(0);
  });

  it("suppresses a complaint as spam_complaint", async () => {
    const events = fakeEmailEventRepo({ created: true });
    const suppress = fakeSuppressionRepo();
    const svc = new DefaultEmailEventService({
      emailEventRepository: events,
      suppressionEntryRepository: suppress,
    });

    const result = await svc.ingestEvent({
      providerEventId: "evt_c1",
      type: "email.complained",
      data: { email_id: "email_2", to: ["spam@example.com"] },
    });

    expect(result.eventType).toBe("complained");
    expect(suppress.suppressed[0]!.reason).toBe("spam_complaint");
  });

  it("does NOT suppress on a redelivery (created=false)", async () => {
    const events = fakeEmailEventRepo({ created: false });
    const suppress = fakeSuppressionRepo();
    const svc = new DefaultEmailEventService({
      emailEventRepository: events,
      suppressionEntryRepository: suppress,
    });

    const result = await svc.ingestEvent(bounceEvent("Permanent"));

    expect(result.created).toBe(false);
    expect(result.suppressed).toBe(false);
    expect(suppress.suppressed).toHaveLength(0);
  });

  it("logs a warn (still persists the event) when a hard bounce has NO recipient", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = fakeEmailEventRepo({ created: true });
    const suppress = fakeSuppressionRepo();
    const svc = new DefaultEmailEventService({
      emailEventRepository: events,
      suppressionEntryRepository: suppress,
    });

    // A hard bounce with an empty/absent recipient: the EmailEvent persists but
    // suppression cannot fire — the skip must be OBSERVABLE, not silent.
    const result = await svc.ingestEvent({
      providerEventId: "evt_no_recipient",
      type: "email.bounced",
      data: { email_id: "email_x", to: [], bounce: { type: "Permanent" } },
    });

    expect(events.recorded).toHaveLength(1); // EmailEvent still persisted
    expect(result.suppressed).toBe(false); // suppression skipped
    expect(suppress.suppressed).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(
      "email.event.suppression.skipped.no_recipient",
    );
    warn.mockRestore();
  });

  it("no-ops email.sent (no EmailEvent persisted)", async () => {
    const events = fakeEmailEventRepo();
    const suppress = fakeSuppressionRepo();
    const svc = new DefaultEmailEventService({
      emailEventRepository: events,
      suppressionEntryRepository: suppress,
    });

    const result = await svc.ingestEvent({
      providerEventId: "evt_s1",
      type: "email.sent",
      data: { email_id: "email_3", to: ["x@example.com"] },
    });

    expect(result.created).toBe(false);
    expect(result.eventType).toBeNull();
    expect(events.recorded).toHaveLength(0);
  });
});
