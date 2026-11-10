import type { HarnessProgram } from "@claudexor/schema";
import { buildRegistry } from "./registry.js";

/** The adapter registry is the only list. No installable-harness allowlist. */
export function harnessPrograms(): HarnessProgram[] {
  return [...buildRegistry({ includeFakes: false }).values()]
    .flatMap((adapter) => (adapter.program ? [adapter.program] : []))
    .sort((a, b) => a.id.localeCompare(b.id));
}
export function harnessProgram(id: string): HarnessProgram {
  const program = harnessPrograms().find((program) => program.id === id);
  if (!program)
    throw Object.assign(new Error(`No local program declaration for ${id}`), {
      code: "harness_not_installable",
    });
  return program;
}
