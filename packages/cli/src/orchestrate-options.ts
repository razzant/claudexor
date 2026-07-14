import {
  OrchestrateAutonomy,
  type OrchestrateAutonomy as OrchestrateAutonomyValue,
} from "@claudexor/schema";

/**
 * Parse `--autonomy <suggest|auto_safe|auto_full>` into the typed
 * OrchestrateAutonomy. An invalid value FAILS LOUDLY (a typo must never silently
 * fall back to `suggest` and skip the execution the user asked for). Returns
 * undefined when the flag is absent (the daemon/orchestrator default to suggest).
 */
export function parseAutonomy(value: string | undefined): OrchestrateAutonomyValue | undefined {
  if (value === undefined) return undefined;
  const parsed = OrchestrateAutonomy.safeParse(value);
  if (!parsed.success)
    throw new Error(`invalid --autonomy '${value}' (expected suggest|auto_safe|auto_full)`);
  return parsed.data;
}
