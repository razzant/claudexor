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
    const result = await runIdempotentDelivery(ctx.services, {
      params: record.params,
      key,
      operation: "run.apply",
      request: {
        runId: record.runId ?? record.id,
        body,
        manifestSha256: candidate.manifestSha256,
        repoRoot: root,
      },
      work: async () => {
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
        // Recorded with the delivery, never by a replay of its receipt: the overlay
        // counts this delivery's writes and the selected changes it found the target
        // already holding against this manifest; a refusal that wrote nothing marks
        // nothing. The receipt's appliedPaths stay its own writes.
        if (delivered.applied || delivered.appliedPaths.length > 0)
          ctx.markFilesApplied?.(
            record,
            [...delivered.appliedPaths, ...filesDeliveryHeldPaths(delivered)],
            candidate.manifest,
            candidate.manifestSha256,
          );
        ctx.appendAudit(record, delivered.applied ? "control.applied" : "control.rejected", {
          control: "apply",
          kind: "files",
          manifest_sha256: candidate.manifestSha256,
          applied: delivered.applied,
          tree_mutated: delivered.treeMutated,
          applied_paths: delivered.appliedPaths,
        });
        return delivered;
      },
    });
    return ControlDeliveryResponse.parse(result);
  });
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
