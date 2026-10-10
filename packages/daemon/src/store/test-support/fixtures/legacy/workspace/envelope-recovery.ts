import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface EnvelopeRecoveryRecord {
  envelopeId: string;
  workspaceMode: "in_place" | "isolated";
  workspaceKind?: "git" | "directory";
}

/** Read only the identity needed to dispose a crashed envelope. The caller
 * decides whether missing legacy data is safe to fall back from. */
export function readEnvelopeRecoveryRecord(base: string): EnvelopeRecoveryRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(base, "owner.json"), "utf8")) as {
      envelope_id?: unknown;
      workspace_mode?: unknown;
      workspace_kind?: unknown;
    };
    if (
      typeof parsed.envelope_id !== "string" ||
      (parsed.workspace_mode !== "in_place" && parsed.workspace_mode !== "isolated")
    ) {
      return null;
    }
    return {
      envelopeId: parsed.envelope_id,
      workspaceMode: parsed.workspace_mode,
      ...(parsed.workspace_kind === "directory" ? { workspaceKind: "directory" } : {}),
    };
  } catch {
    return null;
  }
}

/** `ps` start time for a pid, or null when unavailable. Pid+start-time
 * equality is the recycling-proof liveness identity for envelope owners
 * (command names/titles mutate; the kernel start time never does). */
export function processStartTime(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
