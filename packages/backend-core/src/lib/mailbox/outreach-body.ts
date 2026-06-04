/**
 * analyzeOutreachBody — shared body checks for the email-smoke tools. Used by
 * BOTH the delivered-mail reader (scripts/email-smoke-read.ts, over the parsed
 * IMAP message) and the DB draft-inspect tool (scripts/email-smoke-inspect.ts,
 * over the persisted OutreachMessage). Keeping the checks in one tested place
 * means "what we generated" and "what actually landed" are judged identically.
 *
 * The two flags encode the operator's deliverability rules:
 *   - hasEmDash: an em/en dash in the copy reads as an AI tell to estate agents
 *     and hurts deliverability (the email-style preference), so its PRESENCE is
 *     a red flag.
 *   - hasUnsubscribe: a one-click unsubscribe link MUST be present (RFC 8058 /
 *     compliance), so its ABSENCE is a red flag.
 */
export interface OutreachBodyAnalysis {
  /** Length of the HTML part (0 when there is none). */
  htmlLength: number;
  /** True if an em dash (—) or en dash (–) appears anywhere in the copy. */
  hasEmDash: boolean;
  /** True if the copy contains an unsubscribe affordance. */
  hasUnsubscribe: boolean;
}

export function analyzeOutreachBody(input: {
  text?: string | null;
  html?: string | null;
}): OutreachBodyAnalysis {
  const text = input.text ?? "";
  const html = input.html ?? "";
  const combined = `${text}\n${html}`;
  return {
    htmlLength: html.length,
    hasEmDash: combined.includes("—") || combined.includes("–"),
    hasUnsubscribe: /unsubscribe/i.test(combined),
  };
}
