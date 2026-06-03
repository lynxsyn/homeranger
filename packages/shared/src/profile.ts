/**
 * Buyer-identity + outreach-urgency helpers (Settings "Your details").
 *
 * The operator's own details sign and pace every outreach email:
 *   - firstName/lastName → the sign-off NAME. The buyer's name wins; when blank
 *     the RESEND_FROM display name is the fallback (single source of truth for
 *     "who the email is from" stays the From header).
 *   - phone              → appended to the sign-off when set.
 *   - urgency            → selects the closing "how soon" line. Each level's
 *     `line` REPLACES the default closing sentence ("Happy to move quickly for
 *     the right place."); "browsing" keeps it relaxed with an empty line.
 *
 * `label`/`note` drive the Settings UI only. `line`, `signatureBlock`, and
 * `urgencyLine` are EMAIL COPY and the SINGLE SOURCE OF TRUTH shared by the
 * backend draft (scout-brief.ts) and its client twin (ScoutsPage) so the
 * preview and the sent email never drift.
 */
import { z } from "zod";

// ── Urgency levels ────────────────────────────────────────────────────────
export interface OutreachUrgencyLevel {
  id: "browsing" | "active" | "ready" | "soon";
  /** Settings UI option label. */
  label: string;
  /** Settings UI helper note under the label. */
  note: string;
  /** The email closing line this level injects ("" → keep the default). */
  line: string;
}

export const OUTREACH_URGENCY_LEVELS: readonly OutreachUrgencyLevel[] = [
  {
    id: "browsing",
    label: "Keeping an eye out",
    note: "No rush — I just want to know what's coming up.",
    line: "",
  },
  {
    id: "active",
    label: "Actively looking",
    note: "Searching in earnest and happy to view at short notice.",
    line: "I'm actively looking at the moment and can arrange a viewing at short notice.",
  },
  {
    id: "ready",
    label: "Ready to move",
    note: "Finances are in place — I can proceed quickly on the right home.",
    line: "I'm in a strong position to proceed: my finances are in place and I can move quickly for the right place.",
  },
  {
    id: "soon",
    label: "Need to move soon",
    note: "Working to a timeline and need to find somewhere before long.",
    line: "I'm working to a timeline and need to find the right home before long, so I'd be grateful to hear about anything suitable as early as you can.",
  },
] as const;

export const OutreachUrgencyEnum = z.enum(["browsing", "active", "ready", "soon"]);
export type OutreachUrgency = z.infer<typeof OutreachUrgencyEnum>;
export const OUTREACH_URGENCY_IDS = OutreachUrgencyEnum.options;
/** The Settings default (the design left it at "Actively looking"). */
export const DEFAULT_OUTREACH_URGENCY: OutreachUrgency = "active";

/**
 * The closing line for an urgency id. Returns "" for "browsing" (relaxed) and
 * for any unknown id, so a stale/blank value degrades to the default closing.
 */
export function urgencyLine(id: string | null | undefined): string {
  const level = OUTREACH_URGENCY_LEVELS.find((u) => u.id === id);
  return level ? level.line : "";
}

// ── Buyer identity ────────────────────────────────────────────────────────
/** The buyer-identity subset of a SearchProfile the outreach draft reads. */
export interface BuyerIdentityFields {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  urgency?: string | null;
}

/** "Jane Whitfield" from a profile (trimmed; empty when both names are blank). */
export function buyerFullName(p: BuyerIdentityFields): string {
  return [p.firstName, p.lastName]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

/** The outreach sender, resolved from the buyer profile + a fallback name. */
export interface ResolvedSender {
  /** Sign-off name: buyer's full name, else the fallback (RESEND_FROM) name. */
  name: string | null;
  /** Buyer phone, appended to the sign-off when set. */
  phone: string | null;
  /** Buyer urgency id, selecting the closing line. */
  urgency: string | null;
}

/**
 * Resolve the outreach sender identity from the buyer profile + a fallback
 * display name (the RESEND_FROM sender). The buyer's own name wins; the
 * fallback covers an empty profile; phone + urgency come from the profile.
 */
export function resolveSender(
  profile: BuyerIdentityFields,
  fallbackName: string | null | undefined,
): ResolvedSender {
  const fullName = buyerFullName(profile);
  const phone = (profile.phone ?? "").trim();
  return {
    name: fullName || (fallbackName ?? "").trim() || null,
    phone: phone || null,
    urgency: profile.urgency ?? null,
  };
}

/**
 * Build the email sign-off block from a resolved name + phone:
 *   "Many thanks,\nJane Whitfield\n07700 900123"
 * Falls back to a bare "Many thanks" when neither name nor phone is set.
 */
export function signatureBlock(
  name: string | null | undefined,
  phone: string | null | undefined,
): string {
  const n = (name ?? "").trim();
  const p = (phone ?? "").trim();
  if (!n && !p) {
    return "Many thanks";
  }
  const lines = ["Many thanks,"];
  if (n) {
    lines.push(n);
  }
  if (p) {
    lines.push(p);
  }
  return lines.join("\n");
}
