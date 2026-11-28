import {
  verifyAndDeliverFiles,
  filesDeliveryHeldPaths,
  filesVerifyRefusal,
  finalVerifyFiles,
  finalVerifySpaceFailure,
  withSpaceRefusal,
} from "@claudexor/delivery";
import {
  readWorkspaceFile,
  workspaceFilePath,
  sameWorkspaceFile,
  deliverableWorkspaceChanges,
} from "@claudexor/workspace";
import {
  ControlApplyCheckResponse,
  ControlDeliveryResponse,
  deliveryEffectsStatement,
  type ControlApplyRequest,
} from "@claudexor/schema";
import { runIdempotentDelivery, type RunApplyRouteContext } from "./run-apply-routes.js";
import { readFilesWorkProduct } from "./files-work-product.js";
import type { DaemonRunRecord } from "./run-record.js";

export async function applyFilesResult(
  ctx: RunApplyRouteContext,
  record: DaemonRunRecord,
  body: ControlApplyRequest,
  key: string,
  root: string,
) {
  const candidate = readFilesWorkProduct(record);
  if (!candidate) throw new Error("No files result");
  if (body.mode !== "apply")
    throw Object.assign(
      new Error("Directory results support file application; branch, commit and PR require Git"),
      { status: 400 },
    );
  return ctx.chainMutation(record, async () => {
    // Set by the delivery itself, never by a replay of its receipt.
    const delivery: { fresh?: FilesReceipt } = {};
    let result: FilesReceipt;
    try {
      result = await runIdempotentDelivery(ctx.services, {
        params: record.params,
        key,
        operation: "run.apply",
        request: {
          runId: record.runId ?? record.id,
          body,
          manifestSha256: candidate.manifestSha256,
          repoRoot: root,
        },
        work: async (): Promise<FilesReceipt> => {
          const state = ctx.deliveredApplyState(record);
          if (state === "discarded")
            throw Object.assign(new Error("This result was discarded"), { status: 409 });
          if (candidate.manifest.isolation === "live")
            throw Object.assign(new Error("Direct file effects are already in place"), {
              status: 409,
            });
          const delivered = await verifyAndDeliverFiles(
            root,
            candidate,
            { paths: body.paths },
            ctx.gateSpecs(record),
            (verify) => ctx.gateError(record, "", root, verify),
          );
          // The journal keeps, beside the receipt, what this delivery covered of this
          // manifest: its writes and the selected changes it found the target already
          // holding. A refusal that wrote nothing covers nothing. The receipt's own
          // appliedPaths stay its writes.
          delivery.fresh = {
            ...delivered,
            ...(delivered.applied || delivered.appliedPaths.length > 0
              ? {
                  [FILES_COVERAGE]: {
                    manifestSha256: candidate.manifestSha256,
                    paths: [...delivered.appliedPaths, ...filesDeliveryHeldPaths(delivered)],
                  },
                }
              : {}),
          };
          return delivery.fresh;
        },
      });
    } catch (error) {
      // The target may hold this delivery while its receipt could not be journaled:
      // the answer stays that uncertainty; the run's state still records the writes.
      if (delivery.fresh)
        await reportFilesDelivery(ctx, record, candidate, delivery.fresh, true).catch(
          () => undefined,
        );
      throw error;
    }
    // The receipt is journaled before anything secondary can fail: a later failure
    // can no longer turn this delivery into a failed command.
    await reportFilesDelivery(ctx, record, candidate, result, delivery.fresh !== undefined);
    const { [FILES_COVERAGE]: _coverage, ...receipt } = result;
    return ControlDeliveryResponse.parse(receipt);
  });
}

/** Beside a files receipt in its durable command, never on the wire. */
const FILES_COVERAGE = "filesCoverage";
type FilesReceipt = Record<string, unknown> & {
  applied?: unknown;
  treeMutated?: unknown;
  appliedPaths?: unknown;
  [FILES_COVERAGE]?: { manifestSha256?: unknown; paths?: unknown };
};

/**
 * The run's state and audit after a journaled files receipt. A delivery records
 * both. A replay (its receipt read back from the journal) only converges a
 * not-yet-applied overlay that lacks its coverage of this manifest (a first record
 * that failed): no audit again, no file written, nothing over a later decision,
 * and an unchanged overlay is not rewritten.
 */
async function reportFilesDelivery(
  ctx: RunApplyRouteContext,
  record: DaemonRunRecord,
  candidate: NonNullable<ReturnType<typeof readFilesWorkProduct>>,
  receipt: FilesReceipt,
  fresh: boolean,
): Promise<void> {
  const coverage = receipt[FILES_COVERAGE];
  const paths =
    coverage?.manifestSha256 === candidate.manifestSha256 && Array.isArray(coverage.paths)
      ? coverage.paths.filter((path): path is string => typeof path === "string")
      : null;
  let failure: unknown;
  if (paths && (fresh || ctx.deliveredApplyState(record) === "not_applied"))
    try {
      ctx.markFilesApplied?.(record, paths, candidate.manifest, candidate.manifestSha256);
    } catch (error) {
      failure = error;
    }
  if (fresh)
    try {
      ctx.appendAudit(record, receipt.applied === true ? "control.applied" : "control.rejected", {
        control: "apply",
        kind: "files",
        manifest_sha256: candidate.manifestSha256,
        applied: receipt.applied === true,
        tree_mutated: receipt.treeMutated === true,
        applied_paths: receipt.appliedPaths,
      });
    } catch {
      /* the audit never changes the delivery's answer */
    }
  if (failure !== undefined) throw deliveryStateUnavailable(receipt, failure);
}

/**
 * The run's state could not be recorded after a journaled receipt. The answer
 * still states the delivery's own facts, first and apart from that failure: what
 * it wrote, whether the target changed, and the refusal (code, where it stopped)
 * and detail that ended it. The same key answers the journaled receipt once the
 * state can be recorded.
 */
function deliveryStateUnavailable(receipt: FilesReceipt, cause: unknown): Error {
  const appliedPaths = Array.isArray(receipt.appliedPaths)
    ? receipt.appliedPaths.filter((path): path is string => typeof path === "string")
    : [];
  const detail = typeof receipt["detail"] === "string" ? receipt["detail"] : undefined;
  const refusal = receipt["refusal"] as { code: string; paths: string[] } | undefined;
  const effects =
    receipt.applied === true
      ? `Applied${detail ? ` (${detail})` : ""}.`
      : `Not applied. ${
          deliveryEffectsStatement({
            applied: false,
            appliedPaths,
            treeMutated: receipt.treeMutated === true,
            detail,
            refusal,
          }) ?? ""
        }`.trim();
  return Object.assign(
    new Error(
      `Files delivery: ${effects} Separately, the run's result state could not be updated; repeat this request with the same Idempotency-Key to update it (no file is written again).`,
    ),
    {
      status: 500,
      code: "delivery_state_unavailable",
      retryable: true,
      // Small facts first: a bounded context shortens the path list, never them.
      context: {
        applied: receipt.applied === true,
        treeMutated: receipt.treeMutated === true,
        ...(receipt["refused"] === true ? { refused: true } : {}),
        ...(detail ? { detail } : {}),
        ...(refusal ? { refusal } : {}),
        appliedPaths,
      },
      cause,
    },
  );
}

/** What `accept_clean_patch` says of a files delivery in its existing `message`
 * (its response has no receipt fields); the full typed DeliveryReceipt is Apply's. */
export const filesDecisionMessage = deliveryEffectsStatement;

export async function checkFilesResult(
  ctx: RunApplyRouteContext,
  record: DaemonRunRecord,
  root: string,
  paths?: string[],
) {
  const candidate = readFilesWorkProduct(record);
  if (!candidate) throw new Error("No files result");
  if (candidate.manifest.isolation === "live")
    return ControlApplyCheckResponse.parse({
      ok: true,
      code: 0,
      stderr: "Direct effects are already in place",
      alreadyApplied: true,
    });
  const verify = await finalVerifyFiles(candidate, paths, ctx.gateSpecs(record), {
    emit: () => undefined,
  });
  // Apply's own rule: an accepted risk authorizes only a materialized copy.
  const refused = filesVerifyRefusal(verify, (proven) => ctx.gateError(record, "", root, proven));
  // A verification copy that could not fit is a typed refusal, as the delivery's.
  if (refused)
    return ControlApplyCheckResponse.parse(
      withSpaceRefusal(
        { ok: false, code: 1, stderr: refused },
        verify.applied_cleanly === true ? undefined : finalVerifySpaceFailure(verify),
      ),
    );
  let alreadyApplied = true;
  const selected = deliverableWorkspaceChanges(candidate.manifest, paths);
  const unresolvedUnknown = candidate.manifest.entries.some(
    (entry) =>
      entry.before === "unknown" &&
      entry.after !== null &&
      (paths === undefined ||
        paths.some((path) => entry.path === path || entry.path.startsWith(path + "/"))),
  );
  for (const entry of selected) {
    const actual = await readWorkspaceFile(await workspaceFilePath(root, entry.path, true));
    if (sameWorkspaceFile(entry.after, actual)) continue;
    alreadyApplied = false;
    if (!sameWorkspaceFile(entry.before, actual))
      return ControlApplyCheckResponse.parse({
        ok: false,
        code: 1,
        stderr: `Target changed: ${entry.path}`,
      });
  }
  return ControlApplyCheckResponse.parse({
    ok: true,
    code: 0,
    stderr: unresolvedUnknown ? "Unknown preimage retains custody" : "",
    alreadyApplied: alreadyApplied && !unresolvedUnknown,
  });
}
