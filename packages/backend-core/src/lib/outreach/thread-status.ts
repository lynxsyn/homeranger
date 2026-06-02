/**
 * OutreachThread state-machine reducer (M6 AC#4) — a pure function, no
 * LangGraph/agent framework (scope-discipline.md): the thread lifecycle is a
 * status enum advanced by BullMQ jobs through this single reducer.
 *
 * Legal edges:
 *   active        --outbound_sent--> awaiting_reply
 *   awaiting_reply --outbound_sent--> awaiting_reply   (follow-up; idempotent)
 *   replied        --outbound_sent--> awaiting_reply   (follow-up after a reply)
 *   active|awaiting_reply|replied --inbound_reply--> replied
 *   (any)          --closed--------> closed            (opt-out / unsubscribe)
 *   closed is TERMINAL — no event reopens it.
 *
 * Any event applied to a state with no defined edge is a no-op (returns the
 * current status), so a stray/late event can never illegally rewind the machine.
 */
import type { OutreachThreadStatus } from "@prisma/client";

export type ThreadEvent = "outbound_sent" | "inbound_reply" | "closed";

export function advanceThreadStatus(
  current: OutreachThreadStatus,
  event: ThreadEvent,
): OutreachThreadStatus {
  // `closed` is terminal — nothing reopens a thread the agent opted out of.
  if (current === "closed") {
    return "closed";
  }
  switch (event) {
    case "closed":
      return "closed";
    case "outbound_sent":
      // A send (initial or follow-up) always leaves us awaiting a reply.
      return "awaiting_reply";
    case "inbound_reply":
      return "replied";
    default:
      return current;
  }
}
