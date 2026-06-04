/**
 * extractReplyText — return only what the agent ACTUALLY typed in a reply,
 * stripping the quoted history of the email they replied to.
 *
 * Why this is load-bearing (a live smoke test caught it): an agent's reply quotes
 * our original outreach, whose footer reads "...to STOP receiving these emails,
 * UNSUBSCRIBE here...". The inbound opt-out detector (isUnsubscribeIntent) and the
 * listing extractor both read the raw body, so the quoted footer (a) false-
 * positived the opt-out — auto-suppressing EVERY agent who replied, even to say
 * "yes, here's a listing" — and (b) polluted the extractor's input with the
 * buyer-enquiry quote. Both must see only the agent's new text.
 *
 * Heuristic: cut at the EARLIEST quoted-history boundary. Quote markers are
 * unambiguous (line-anchored) so a normal reply that merely mentions ">" or "on"
 * mid-sentence is never truncated. No external dependency; deterministic + fully
 * unit-tested against the major clients (Gmail, Apple Mail, Outlook, Proton,
 * Thunderbird). Signatures are deliberately NOT stripped — they are the agent's
 * own text and never carry an unsubscribe footer.
 */

// Each marker is a LINE-ANCHORED pattern (non-global so `.exec` returns the first
// match's index). Order does not matter — we take the minimum index across all.
const QUOTE_MARKERS: readonly RegExp[] = [
  // Gmail / Apple Mail / Proton / Thunderbird attribution: a line that starts
  // with "On " and ends with "wrote:". Bounded so it stays a single line.
  /^[ \t]*On\b.{0,400}\bwrote:[ \t]*$/m,
  // Outlook reply separator.
  /^[ \t]*-{2,}\s*Original Message\s*-{2,}/im,
  // Outlook header block (From: immediately followed by Sent:).
  /^[ \t]*From:[ \t].+\n[ \t]*Sent:[ \t].+$/m,
  // Outlook divider line (a run of underscores).
  /^[ \t]*_{10,}[ \t]*$/m,
  // Any quoted line (the quoted history is `>`-prefixed across every client).
  /^>.*$/m,
];

export function extractReplyText(raw: string | null | undefined): string {
  if (!raw) {
    return "";
  }
  const text = raw.replace(/\r\n/g, "\n");
  let cut = text.length;
  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(text);
    if (match && match.index < cut) {
      cut = match.index;
    }
  }
  return text.slice(0, cut).trim();
}

// http(s) URL up to the next whitespace / bracket. Trailing sentence punctuation
// is trimmed so "see https://rightmove.co.uk/123." captures the link, not the dot.
const HTTP_URL_RE = /\bhttps?:\/\/[^\s<>()]+/i;

/**
 * The first http(s) link in some text, or null. Used as the DETERMINISTIC
 * fallback for a listing's clickable source URL when the LLM extractor returns
 * none — so an agent who replies with a Rightmove/Zoopla/agency link still gets a
 * clickable listing in the app. Run it on the stripped reply (extractReplyText)
 * so our own quoted unsubscribe URL is never picked up.
 */
export function firstHttpUrl(text: string | null | undefined): string | null {
  if (!text) {
    return null;
  }
  const match = HTTP_URL_RE.exec(text);
  if (!match) {
    return null;
  }
  return match[0].replace(/[.,;:!?)\]]+$/, "");
}
