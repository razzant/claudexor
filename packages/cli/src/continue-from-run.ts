/**
 * What the daemon hands a run about the `continueFrom` chain (RunInput
 * `continuation`): every daemon-owned run may keep its stopped isolated work
 * for continuation (only the daemon admits a successor or discards a kept
 * envelope); a successor additionally names its predecessor and, when it runs
 * in the predecessor's workspace, adopts the predecessor's retained envelope.
 *
 * Delegate belt children keep the ordinary dispose: their parent integrates
 * their results and starts new children, so a kept child tree would only
 * accumulate. Admission (INTERFACES §1) already proved the predecessor is a
 * terminal run of this daemon; this resolves it from the same records.
 */
import { statSync } from "node:fs";
import { RunScope, type ControlRunStartRequest } from "@claudexor/schema";
import type { RunInput } from "@claudexor/orchestrator";
import { retainedEnvelopeInChain } from "@claudexor/workspace";

interface ChainRecord {
  runId?: string;
  runDir?: string;
  state: string;
  params: unknown;
}
interface CommandRecords {
  getByRunId(runId: string): ChainRecord | undefined;
}

function paramsOf(record: ChainRecord): Record<string, unknown> {
  return record.params && typeof record.params === "object"
    ? (record.params as Record<string, unknown>)
    : {};
}

/** Head first, with cycle protection for malformed historical links. */
function predecessorChain(records: CommandRecords, predecessor: ChainRecord): ChainRecord[] {
  const chain: ChainRecord[] = [];
  const seen = new Set<string>();
  for (
    let record: ChainRecord | undefined = predecessor;
    record?.runId && !seen.has(record.runId);
  ) {
    seen.add(record.runId);
    chain.push(record);
    const parent: unknown = paramsOf(record)["continueFrom"];
    record = typeof parent === "string" ? records.getByRunId(parent) : undefined;
  }
  return chain;
}

export function continuationForRun(
  p: ControlRunStartRequest,
  commands: CommandRecords,
): NonNullable<RunInput["continuation"]> {
  const retain = !p.delegatedFromRunId;
  if (!p.continueFrom) return { retain };
  const predecessor = commands.getByRunId(p.continueFrom);
  let sourceAvailable = false;
  try {
    sourceAvailable = !!predecessor?.runDir && statSync(predecessor.runDir).isDirectory();
  } catch {
    /* A vanished or unreadable source cannot become fresh work. */
  }
  if (!predecessor?.runId || !predecessor.runDir || !sourceAvailable) {
    throw Object.assign(new Error("admitted continuation predecessor is no longer available"), {
      code: "continuation_predecessor_unavailable",
      status: 404,
      retryable: false,
      context: { predecessor: p.continueFrom },
      requiredActions: ["Restore the predecessor's run artifacts or explicitly start a new run."],
    });
  }
  // An explicit live root or another project runs elsewhere: the kept envelope stays kept.
  const chain = predecessorChain(commands, predecessor);
  const sources = chain.flatMap((record) => {
    if (!record.runId || !record.runDir) return [];
    const scope = RunScope.safeParse(paramsOf(record)["scope"]).data;
    return [
      {
        runId: record.runId,
        runDir: record.runDir,
        state: record.state,
        ...(scope?.kind === "project" ? { scopeRoot: scope.root } : {}),
      },
    ];
  });
  const kept = retainedEnvelopeInChain(sources);
  const ownWorkspace =
    p.execution.isolation !== "live" &&
    !p.execution.workspaceRoot &&
    p.scope.kind === "project" &&
    kept?.envelope.repo_root === p.scope.root;
  return {
    retain,
    adopt: ownWorkspace ? kept : null,
    from: {
      ...sources[0]!,
      workOrder: chain
        .map((record) => paramsOf(record)["prompt"])
        .filter((prompt): prompt is string => typeof prompt === "string" && !!prompt.trim())
        .reverse()
        .map((prompt) => prompt.trim())
        .join("\n\n"),
      ancestors: sources.slice(1),
      preference: p.continueCarrier ?? "auto",
      inheritModel: p.continueModelInherited ?? (p.model === undefined && p.models === undefined),
    },
  };
}
