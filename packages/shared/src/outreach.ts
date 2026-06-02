/**
 * Outreach control contracts shared FE/BE (PR3). Currently the global send
 * kill-switch toggle: the operator flips this to halt ALL outbound sends at once
 * (ComplianceGuard gate 5 reads WarmupState.killSwitch). Mirrors the `.strict()`
 * style of the sibling schemas.
 */
import { z } from "zod";

/** Toggle the global outreach kill-switch (ComplianceGuard gate 5). */
export const killSwitchToggleInputSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();
export type KillSwitchToggleInput = z.infer<typeof killSwitchToggleInputSchema>;
