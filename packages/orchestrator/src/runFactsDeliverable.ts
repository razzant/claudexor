import { lstatSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { DecisionRecord, RunFacts, RunTelemetry, WorkProduct } from "@claudexor/schema";
import { readTextSafe, sha256 } from "@claudexor/util";
import { WorkspaceFilesManifest } from "@claudexor/schema";
import { sameWorkspaceFile } from "@claudexor/workspace";
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
  if (args.workProduct?.kind === "files") {
    const path = args.workProduct.files.manifest;
    const text = path ? readTextSafe(join(args.ctx.paths.root, path)) : null;
    if (!text || sha256(text) !== args.workProduct.meta.manifest_sha256)
      throw new Error("Files work product manifest is missing or changed");
    const manifest = WorkspaceFilesManifest.parse(JSON.parse(text));
    if (
      manifest.complete &&
      (args.workProduct.meta.no_changes === false ||
        manifest.entries.some(
          (entry) => entry.after !== null && !sameWorkspaceFile(entry.before, entry.after),
        ))
    )
      candidates.push({ kind: "files", path });
  }
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
      // invariant failure for a valid dual-output run. An object result
      // without a rendered view (#535) is that deliverable in its canonical
      // form: the work product naming its trees, never an empty patch.diff.
      const unrendered =
        (args.workProduct?.meta["patch_view"] as { available?: unknown } | undefined)?.available ===
          false && args.workProduct?.meta["git_result"] !== undefined;
      if (unrendered) candidates.push({ kind: "patch", path: "final/work_product.yaml" });
      candidates.push({ kind: "patch", path: "final/patch.diff" }, structuredOutput, {
        kind: "answer",
        path: "final/answer.md",
      });
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
  const producerAttemptId =
    args.workProduct?.producer_attempt_id ??
    args.decision?.winner ??
    args.telemetry?.final_attempt_id ??
    null;
  // The file probe alone cannot see an honestly empty answer/report: the
  // read-only final artifact wrapper (title heading + the "(no output)"
  // marker) makes final/answer.md non-empty BY CONSTRUCTION. For those two
  // kinds the D-16 attempt record is the one owner of "delivered" — when the
  // identified producer attested deliverable_present=false, the run truly
  // delivered nothing and the receipt projects an absent deliverable (a clean
  // empty ask completion), instead of manufacturing a producer/deliverable
  // invariant contradiction that would rewrite an honest completion into a
  // fake harness failure. Wrapper-free kinds (patch, plan, structured output)
  // keep the strict cross-check: real file content contradicting the record
  // stays a loud terminal-facts failure, and the probe above still
  // fail-closes the opposite lie (issue #29: a zero-byte artifact can never
  // count as present, whatever the attempt claimed).
  if (producerAttemptId && (selected.kind === "answer" || selected.kind === "report")) {
    const producer = args.telemetry?.attempts.find(
      (attempt) => attempt.attempt_id === producerAttemptId,
    );
    if (producer && producer.outcome.deliverable_present === false) {
      return {
        present: false,
        kind: null,
        path: null,
        producer_attempt_id: null,
      };
    }
  }
  return {
    present: true,
    kind: selected.kind,
    path: selected.path,
    producer_attempt_id: producerAttemptId,
  };
}
