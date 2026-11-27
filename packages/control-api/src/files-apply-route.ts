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
    // The overlay counts this delivery's writes and the changes it found the
    // target already holding (an earlier partial delivery's, compared against
    // this manifest); the receipt's own appliedPaths stay its writes.
    const held = filesDeliveryHeldPaths(result);
    if (
      ctx.deliveredApplyState(record) !== "discarded" &&
      (result.appliedPaths.length || held.length || result.applied)
    )
      ctx.markFilesApplied?.(record, [...result.appliedPaths, ...held], candidate.manifest);
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

const listed = (paths: readonly string[]) =>
  `${paths.slice(0, 20).join(", ")}${paths.length > 20 ? ` and ${paths.length - 20} more` : ""}`;

/**
 * What `accept_clean_patch` says of a files delivery in its existing `message`
 * (its response has no receipt fields): the delivery's detail and, for one that
 * did not apply, its typed refusal with the path it stopped at and the paths it
 * had already written. The full typed DeliveryReceipt is the one Apply answers.
 */
export function filesDecisionMessage(receipt: {
  applied: boolean;
  appliedPaths?: readonly string[] | undefined;
  detail?: string | undefined;
  refusal?: { code: string; paths: readonly string[] } | undefined;
}): string | undefined {
  if (receipt.applied) return receipt.detail;
  const refusal = receipt.refusal;
  const parts = [
    receipt.detail,
    refusal
      ? `Refusal: ${refusal.code}${refusal.paths.length > 0 ? ` at ${listed(refusal.paths)}` : ""}.`
      : undefined,
    receipt.appliedPaths?.length
      ? `Already written before it stopped: ${listed(receipt.appliedPaths)}.`
      : refusal
        ? "Nothing was written before it stopped."
        : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : undefined;
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
