import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  OutputReadyPayload,
  type RunEvent,
  type RunFacts,
  type RunPresentationPrimary,
} from "@claudexor/schema";
import { readTextSafe } from "@claudexor/util";
import type { AnnouncedRunContext } from "./runTerminals.js";

interface MaterializedArtifact {
  path: string;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolve an announced artifact without following a stand-in outside the run.
 * Missing, empty, non-regular, symlinked, or escaping announcements are
 * terminal-facts contradictions rather than presentation hints to ignore.
 */
function requiredAnnouncedArtifact(ctx: AnnouncedRunContext, path: string): MaterializedArtifact {
  if (path.includes("\0") || path.includes("\\") || isAbsolute(path)) {
    throw new Error(`output.ready announced an unsafe artifact path: ${path}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`output.ready announced an unsafe artifact path: ${path}`);
  }
  const rootStat = lstatSync(ctx.paths.root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("run artifact root is not a safe directory");
  }
  const root = realpathSync(ctx.paths.root);
  const absolute = resolve(root, path);
  if (!isInside(root, absolute)) {
    throw new Error(`output.ready artifact escapes the run root: ${path}`);
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolute);
  } catch {
    throw new Error(`output.ready artifact did not materialize: ${path}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`output.ready artifact is not a safe regular file: ${path}`);
  }
  const real = realpathSync(absolute);
  if (!isInside(root, real)) {
    throw new Error(`output.ready artifact escapes the run root: ${path}`);
  }
  return { path };
}

function optionalMaterializedArtifact(
  ctx: AnnouncedRunContext,
  path: string,
): MaterializedArtifact | null {
  try {
    const artifact = requiredAnnouncedArtifact(ctx, path);
    const absolute = resolve(realpathSync(ctx.paths.root), path);
    return (readTextSafe(absolute)?.trim().length ?? 0) > 0 ? artifact : null;
  } catch {
    return null;
  }
}

function standardPrimaryCandidates(mode: AnnouncedRunContext["mode"]): RunPresentationPrimary[] {
  if (mode === "ask") {
    return [
      { kind: "structured_output", path: "final/output.json" },
      { kind: "answer", path: "final/answer.md" },
      { kind: "report", path: "final/report.md" },
    ];
  }
  if (mode === "plan") return [{ kind: "plan", path: "final/plan.md" }];
  return [
    { kind: "structured_output", path: "final/output.json" },
    { kind: "answer", path: "final/answer.md" },
    { kind: "files", path: "final/files/result.md" },
    { kind: "patch", path: "final/patch.diff" },
  ];
}

/** Build the immutable presentation receipt from the ordered output.ready log. */
export function terminalPresentation(
  ctx: AnnouncedRunContext,
  events: readonly RunEvent[] = ctx.log.readAll().events,
): RunFacts["presentation"] {
  const receipts = events
    .filter((event) => event.type === "output.ready")
    .map((event) => {
      const parsed = OutputReadyPayload.safeParse(event.payload);
      if (!parsed.success) throw new Error("output.ready payload is invalid");
      requiredAnnouncedArtifact(ctx, parsed.data.path);
      return parsed.data;
    });
  const last = receipts.at(-1);
  if (!last) return { state: "diagnostic", primary: null };

  const candidates = standardPrimaryCandidates(ctx.mode);
  if (last.state === "ready") {
    const primary = candidates.find(
      (candidate) => optionalMaterializedArtifact(ctx, candidate.path) !== null,
    );
    // A successful summary may announce that finalization is complete, but it
    // never becomes the primary model output. No-change runs therefore carry
    // ready + null instead of promoting summary.md.
    return { state: "ready", primary: primary ?? null };
  }

  const diagnosticPaths = new Set(
    receipts.filter((receipt) => receipt.state === "diagnostic").map((receipt) => receipt.path),
  );
  const primary = candidates.find(
    (candidate) =>
      diagnosticPaths.has(candidate.path) &&
      optionalMaterializedArtifact(ctx, candidate.path) !== null,
  );
  const retained = receipts.findLast(
    (receipt) =>
      receipt.state === "diagnostic" &&
      receipt.kind === "report" &&
      optionalMaterializedArtifact(ctx, receipt.path) !== null,
  );
  return {
    state: "diagnostic",
    primary: retained
      ? { kind: "report", path: retained.path }
      : (primary ?? { kind: "diagnostic", path: last.path }),
  };
}

/** Minimal fail-closed presentation when ordinary terminal preparation failed. */
export function terminalFactsFailurePresentation(
  ctx: AnnouncedRunContext,
): NonNullable<RunFacts["presentation"]> {
  return {
    state: "diagnostic",
    primary:
      optionalMaterializedArtifact(ctx, "final/summary.md") !== null
        ? { kind: "diagnostic", path: "final/summary.md" }
        : null,
  };
}
