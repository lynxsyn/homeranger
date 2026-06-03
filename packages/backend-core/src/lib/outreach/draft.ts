/**
 * Outreach draft composer (M6). DELIBERATELY TEMPLATE-BASED, not LLM-generated:
 * the draft interpolates only trusted, structured fields (agent name/agency,
 * covered outcodes, the operator's own search-profile preferences) — so there
 * is no prompt-injection surface from agent-controlled inbound text, the output
 * is deterministic + E2E-testable, and there is zero LLM spend. AC#5's
 * no-training/zero-retention LLM posture is documented in the ROPA for the
 * extraction/vision/match calls that DO process personal data (see
 * docs/compliance/ropa.md); the outreach draft makes no model call.
 */
export interface OutreachDraftInput {
  agentName?: string | null;
  agencyName?: string | null;
  coveredOutcodes?: string[];
  /** The operator's free-text search preferences (from the SearchProfile). */
  profilePreferences?: string | null;
  /** Absolute one-click unsubscribe URL appended to the body footer. */
  unsubscribeUrl?: string;
}

export interface OutreachDraft {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function draftOutreach(input: OutreachDraftInput): OutreachDraft {
  const greetingName = input.agentName?.trim() || input.agencyName?.trim() || "there";
  const areas =
    input.coveredOutcodes && input.coveredOutcodes.length > 0
      ? input.coveredOutcodes.join(", ")
      : "your area";
  const prefs = input.profilePreferences?.trim();

  const subject = "Buyer enquiry: pre-market and upcoming listings";

  const lines = [
    `Hello ${greetingName},`,
    "",
    `I'm a serious buyer actively searching in ${areas} and would value being kept in mind for suitable homes, including pre-market or upcoming instructions before they go live.`,
    ...(prefs ? ["", `In brief, I'm looking for: ${prefs}.`] : []),
    "",
    "If you have anything that might fit, a quick reply with the details (or a link) would be very welcome.",
    "",
    "Many thanks,",
    "HomeRanger (on behalf of the buyer)",
  ];
  const bodyText = input.unsubscribeUrl
    ? [
        ...lines,
        "",
        "--",
        `To stop receiving these emails, unsubscribe here: ${input.unsubscribeUrl}`,
      ].join("\n")
    : lines.join("\n");

  const htmlBody = lines
    .map((line) => (line === "" ? "<br/>" : `<p>${escapeHtml(line)}</p>`))
    .join("");
  const bodyHtml = input.unsubscribeUrl
    ? `${htmlBody}<hr/><p style="font-size:12px;color:#888">To stop receiving these emails, <a href="${escapeHtml(
        input.unsubscribeUrl,
      )}">unsubscribe here</a>.</p>`
    : htmlBody;

  return { subject, bodyText, bodyHtml };
}
