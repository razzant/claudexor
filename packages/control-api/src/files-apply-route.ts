import {
  verifyAndDeliverFiles,
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
        return verifyAndDeliverFiles(
          root,
          candidate,
          { paths: body.paths },
          ctx.gateSpecs(record),
          (verify) => ctx.gateError(record, "", root, verify),
        );
      },
    });
    if (
      ctx.deliveredApplyState(record) !== "discarded" &&
      (result.appliedPaths.length || result.applied)
    )
      ctx.markFilesApplied?.(record, result.appliedPaths, candidate.manifest);
    ctx.appendAudit(record, result.applied ? "control.applied" : "control.rejected", {
      control: "apply",
      kind: "files",
      manifest_sha256: candidate.manifestSha256,
      applied: result.applied,
      tree_mutated: result.treeMutated,
      applied_paths: result.appliedPaths,
    });
    return ControlDeliveryResponse.parse(result);
  });
}

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
  const refused = ctx.gateError(record, "", root, verify);
  // A verification copy that could not fit is a typed refusal, as the delivery's.
  if (refused)
    return ControlApplyCheckResponse.parse(
      withSpaceRefusal({ ok: false, code: 1, stderr: refused }, finalVerifySpaceFailure(verify)),
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
