/**
 * Agents input contracts shared FE/BE (PR1). The Agents screen lists the
 * discovered estate-agent pool enriched with each agent's latest outreach-thread
 * status + the count of homes it has sent. Both procedures take the SAME optional
 * `outcodes` scope so the search drill-in can narrow the pool to one patch
 * (absent / empty → every agent). Mirrors the `.strict()` style of the sibling
 * schemas (`./searches.js`, `./outreach.js`); outcodes are capped to bound the
 * query.
 */
import { z } from "zod";

/** List the discovered agents, optionally scoped to a patch's outcodes. */
export const agentsListInputSchema = z
  .object({ outcodes: z.array(z.string()).max(100).optional() })
  .strict();
export type AgentsListInput = z.infer<typeof agentsListInputSchema>;

/** Aggregate the agents' metrics over the SAME optional outcode scope. */
export const agentsStatsInputSchema = z
  .object({ outcodes: z.array(z.string()).max(100).optional() })
  .strict();
export type AgentsStatsInput = z.infer<typeof agentsStatsInputSchema>;
