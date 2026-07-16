import type { HarnessRunSpec } from "@claudexor/schema";

/**
 * Layer caller-supplied per-run instructions onto the prompt for harnesses with
 * NO native system-prompt flag (cursor, opencode, raw-api). Claude and Codex use
 * their native additive channels (`--append-system-prompt`, `developer_instructions`)
 * instead and never call this. The block is explicitly delimited so the model
 * reads it as system framing, not as part of the user's request.
 */
export function promptWithInstructions(
  spec: Pick<HarnessRunSpec, "prompt" | "instructions">,
): string {
  const instructions = spec.instructions?.trim();
  if (!instructions) return spec.prompt;
  return `[SYSTEM INSTRUCTIONS]\n${instructions}\n[END SYSTEM INSTRUCTIONS]\n\n${spec.prompt}`;
}
