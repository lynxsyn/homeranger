/**
 * Prometheus metrics for the M6 ComplianceGuard + outreach send path. Mirrors
 * the import-safe `getSingleMetric(...) ?? new Counter(...)` idiom from
 * lib/queue/queue-metrics.ts so a double import (api + processor) never
 * re-registers and throws.
 *
 * PII rule: the `reason` label is a FIXED low-cardinality enum (the gate codes
 * only) — NEVER the agent email or any free text. Blocked-send logs likewise
 * carry agentId (uuid) + code + reason ONLY.
 */
import { Counter, Registry } from "prom-client";

export const complianceMetricsRegistry = new Registry();

/** Every send the guard blocked, by gate code (fixed low-cardinality label). */
export const complianceBlockedTotal: Counter<"reason"> =
  (complianceMetricsRegistry.getSingleMetric(
    "homeranger_compliance_blocked_total",
  ) as Counter<"reason"> | undefined) ??
  new Counter({
    name: "homeranger_compliance_blocked_total",
    help: "Outreach sends blocked by the ComplianceGuard, labelled by gate code",
    labelNames: ["reason"],
    registers: [complianceMetricsRegistry],
  });

/** Outbound emails actually dispatched (post-guard, post-provider). */
export const outreachSentTotal: Counter<string> =
  (complianceMetricsRegistry.getSingleMetric(
    "homeranger_outreach_sent_total",
  ) as Counter<string> | undefined) ??
  new Counter({
    name: "homeranger_outreach_sent_total",
    help: "Outbound outreach emails dispatched through the EmailProvider",
    registers: [complianceMetricsRegistry],
  });
