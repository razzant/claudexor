/**
 * User-level trust services for the control API (narrow by design): list the
 * per-repo trust files and grant/revoke ONE flag — the same file/writer
 * `claudexor trust` owns. Every other trust field stays CLI-only. Shapes are
 * the schema-owned ControlTrustState (no local DTO forks).
 */
import { isAbsolute } from "node:path";
import { ControlTrustListResponse, ControlTrustState } from "@claudexor/schema";
import { listTrustConfigs, updateTrustConfig } from "@claudexor/config";

export async function listTrustService(): Promise<ControlTrustListResponse> {
  return ControlTrustListResponse.parse({
    entries: listTrustConfigs().map(({ path, config }) => ({
      repoRoot: config.repo_root,
      path,
      allowFullAccess: config.allow_full_access,
      accessDefault: config.access_default,
    })),
  });
}

export async function updateTrustService(input: { repoRoot: string; allowFullAccess: boolean }): Promise<ControlTrustState> {
  if (!isAbsolute(input.repoRoot)) {
    throw Object.assign(new Error(`repoRoot must be an absolute path (got ${input.repoRoot})`), { status: 400 });
  }
  const res = updateTrustConfig(input.repoRoot, (cfg) => ({
    ...cfg,
    allow_full_access: input.allowFullAccess,
  }));
  return ControlTrustState.parse({
    repoRoot: res.config.repo_root,
    path: res.path,
    allowFullAccess: res.config.allow_full_access,
    accessDefault: res.config.access_default,
  });
}
