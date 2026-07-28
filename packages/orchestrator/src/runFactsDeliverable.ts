import { lstatSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { DecisionRecord, RunFacts, RunTelemetry, WorkProduct } from "@claudexor/schema";
import { readTextSafe } from "@claudexor/util";
import type { AnnouncedRunContext } from "./runTerminals.js";
import type { OrchestratorResult } from "./orchestrator.js";

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** The canonical primary deliverable of a terminal run: mode/result-kind
 * ordered candidate paths probed with lstat and a real-content requirement. */
export function canonicalDeliverable(args: {
  ctx: AnnouncedRunContext;
  mode: OrchestratorResult["mode"];
  workProduct: WorkProduct | null;
  telemetry: RunTelemetry | null;
  decision: DecisionRecord | null;
}): RunFacts["deliverable"] {
  const candidates: Array<{
    kind: NonNullable<RunFacts["deliverable"]["kind"]>;
    path: string;
  }> = [];
  const structuredOutput = { kind: "structured_output" as const, path: "final/output.json" };
  if (args.mode === "plan") {
    candidates.push({ kind: "plan", path: "final/plan.md" });
    candidates.push(structuredOutput);
  } else {
    const resultKind = args.workProduct?.meta["result_kind"];
    if (resultKind === "patch" || args.workProduct?.kind === "patch") {
      // A patch remains the canonical deliverable even when the same run also
      // satisfied a structured-output contract. Apply eligibility is bound to
      // this exact patch; choosing output.json here would manufacture an
      // invariant failure for a valid dual-output run.
      candidates.push(
        { kind: "patch", path: "final/patch.diff" },
        structuredOutput,
        { kind: "answer", path: "final/answer.md" },
      );
    } else if (resultKind === "report") {
      candidates.push(
        structuredOutput,
        { kind: "report", path: "final/report.md" },
        { kind: "answer", path: "final/answer.md" },
      );
    } else {
      candidates.push(
        structuredOutput,
        { kind: "answer", path: "final/answer.md" },
        { kind: "report", path: "final/report.md" },
        { kind: "patch", path: "final/patch.diff" },
      );
    }
  }
  const selected = candidates.find((candidate) => {
    const absolute = join(args.ctx.paths.root, candidate.path);
    // Symmetric with this projection's other fences: lstat (a symlinked
    // stand-in is not a canonical deliverable) and real content for EVERY
    // kind — a zero-byte final/plan.md counted as `present:true` was the core
    // of issue #29's false green.
    const stat = lstatOrNull(absolute);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return false;
    return (readTextSafe(absolute)?.trim().length ?? 0) > 0;
  });
  if (!selected) {
    return {
      present: false,
      kind: null,
      path: null,
      producer_attempt_id: null,
    };
  }
  return {
    present: true,
    kind: selected.kind,
    path: selected.path,
    producer_attempt_id:
      args.workProduct?.producer_attempt_id ??
      args.decision?.winner ??
      args.telemetry?.final_attempt_id ??
      null,
  };
}
