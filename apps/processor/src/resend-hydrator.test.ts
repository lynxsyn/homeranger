/**
 * Unit tests for RealResendHydrator attachment CAPS (M4 review fix — CRITICAL:
 * unbounded attachment count/aggregate size = OOM + unbounded Claude spend). The
 * hydrator is the PRIMARY guard: it must drop attachments beyond the count cap
 * and the aggregate-byte budget BEFORE buffering them resident, with a log.warn
 * (NOT a throw — a spammy email still ingests its first in-budget attachments).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RealResendHydrator } from "./resend-hydrator.js";
import { MAX_ATTACHMENTS_PER_EMAIL } from "@homeranger/backend-core/lib/ai/listing-extraction.adapter";
import type { R2Storage } from "@homeranger/backend-core/lib/storage/r2";
import type { InboundEmailJobPayload } from "@homeranger/backend-core/lib/queue/queue-config";
import type { Resend } from "resend";

function fakeResend(attachmentCount: number): Resend {
  const attachments = Array.from({ length: attachmentCount }, (_, i) => ({
    id: `att-${i}`,
    filename: `file-${i}.bin`,
    content_type: "application/octet-stream",
  }));
  return {
    emails: {
      receiving: {
        async get() {
          return {
            data: {
              created_at: new Date().toISOString(),
              to: ["inbox@homeranger.app"],
              from: "agent@example.com",
              subject: "s",
              text: "body",
              html: null,
              headers: {},
              attachments,
            },
            error: null,
          };
        },
        attachments: {
          async get({ id }: { emailId: string; id: string }) {
            return {
              data: { download_url: `https://dl.example.test/${id}` },
              error: null,
            };
          },
        },
      },
    },
  } as unknown as Resend;
}

function fakeStorage(): R2Storage {
  return {
    async putAttachment() {
      return { url: "https://r2.example.test/x", key: "x" };
    },
  } as unknown as R2Storage;
}

/** A fake Resend whose received-email carries a chosen `from` + headers (no
 *  attachments), for exercising the SPF/DKIM alignment downgrade. */
function fakeResendAuth(from: string, headers: Record<string, string>): Resend {
  return {
    emails: {
      receiving: {
        async get() {
          return {
            data: {
              created_at: new Date().toISOString(),
              to: ["inbox@homeranger.app"],
              from,
              subject: "s",
              text: "body",
              html: null,
              headers,
              attachments: [],
            },
            error: null,
          };
        },
        attachments: {
          async get() {
            return { data: { download_url: "x" }, error: null };
          },
        },
      },
    },
  } as unknown as Resend;
}

function authResults(line: string): Record<string, string> {
  return { "authentication-results": `mx.resend.com; ${line}` };
}

function meta(): InboundEmailJobPayload {
  return {
    email_id: "email-caps-1",
    from: "agent@example.com",
    to: ["inbox@homeranger.app"],
    attachments: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("RealResendHydrator — attachment caps", () => {
  it("caps the attachment COUNT and stays within the aggregate byte budget", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // 100 attachments, each 1 MB (no content-length header → post-download
    // byteLength check governs). Aggregate budget 20 MB, count cap 10 → at most
    // 10 kept, ≤ 20 MB total.
    const perAttachmentBytes = 1024 * 1024;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        async arrayBuffer() {
          return new ArrayBuffer(perAttachmentBytes);
        },
      })),
    );

    const hydrator = new RealResendHydrator({
      resend: fakeResend(100),
      storage: fakeStorage(),
    });

    const result = await hydrator.hydrate(meta());

    // Count cap holds.
    expect(result.attachments.length).toBeLessThanOrEqual(
      MAX_ATTACHMENTS_PER_EMAIL,
    );
    // Aggregate budget holds (default 20 MB).
    const total = result.attachments.reduce((s, a) => s + a.byteSize, 0);
    expect(total).toBeLessThanOrEqual(20 * 1024 * 1024);
    // It did NOT throw — the email still ingested its in-budget attachments.
    expect(result.attachments.length).toBeGreaterThan(0);
  });

  it("drops a single oversize attachment (over the per-attachment cap)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // One 50 MB attachment — over the 10 MB per-attachment cap → dropped, no throw.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h === "content-length" ? String(50 * 1024 * 1024) : null) },
        async arrayBuffer() {
          return new ArrayBuffer(1); // never reached (content-length short-circuits)
        },
      })),
    );

    const hydrator = new RealResendHydrator({
      resend: fakeResend(1),
      storage: fakeStorage(),
    });

    const result = await hydrator.hydrate(meta());
    expect(result.attachments.length).toBe(0);
  });
});

describe("RealResendHydrator — SPF/DKIM alignment (anti-spoofing)", () => {
  it("keeps a pass when the auth identity aligns with the From domain", async () => {
    const hydrator = new RealResendHydrator({
      resend: fakeResendAuth(
        "Branch <branch@agency.co.uk>",
        authResults(
          "spf=pass smtp.mailfrom=branch@agency.co.uk; dkim=pass header.d=agency.co.uk",
        ),
      ),
      storage: fakeStorage(),
    });
    const result = await hydrator.hydrate(meta());
    expect(result.spfVerdict).toBe("pass");
    expect(result.dkimVerdict).toBe("pass");
  });

  it("DOWNGRADES a DKIM pass signed by a non-aligned domain (d=attacker.com vs From agency.co.uk)", async () => {
    // The L1 spoof: attacker DKIM-signs as their OWN domain, so the bare token
    // is dkim=pass but it does not attest the spoofed From.
    const hydrator = new RealResendHydrator({
      resend: fakeResendAuth(
        "branch@agency.co.uk",
        authResults("dkim=pass header.d=attacker.com; spf=fail"),
      ),
      storage: fakeStorage(),
    });
    const result = await hydrator.hydrate(meta());
    expect(result.dkimVerdict).toBe("fail");
    expect(result.spfVerdict).toBe("fail");
  });

  it("DOWNGRADES an SPF pass whose mailfrom domain does not align with From", async () => {
    const hydrator = new RealResendHydrator({
      resend: fakeResendAuth(
        "branch@agency.co.uk",
        authResults("spf=pass smtp.mailfrom=bounce@attacker.com; dkim=none"),
      ),
      storage: fakeStorage(),
    });
    const result = await hydrator.hydrate(meta());
    expect(result.spfVerdict).toBe("fail");
  });

  it("treats a signing subdomain as aligned (relaxed/organizational alignment)", async () => {
    const hydrator = new RealResendHydrator({
      resend: fakeResendAuth(
        "branch@agency.co.uk",
        authResults("dkim=pass header.d=mail.agency.co.uk"),
      ),
      storage: fakeStorage(),
    });
    const result = await hydrator.hydrate(meta());
    expect(result.dkimVerdict).toBe("pass");
  });

  it("leaves a pass untouched when the identity domain is unparseable (no false-negative)", async () => {
    // A pass with no header.d=/smtp.mailfrom= token: we cannot prove
    // misalignment, so we must NOT block legitimate mail.
    const hydrator = new RealResendHydrator({
      resend: fakeResendAuth("branch@agency.co.uk", authResults("dkim=pass")),
      storage: fakeStorage(),
    });
    const result = await hydrator.hydrate(meta());
    expect(result.dkimVerdict).toBe("pass");
  });
});
