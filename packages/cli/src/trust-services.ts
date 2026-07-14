/** User-level trust services behind the typed control API. */
import { isAbsolute } from "node:path";
import {
  ControlTrustListResponse,
  ControlTrustState,
  type ControlTrustUpdateRequest,
} from "@claudexor/schema";
import {
  listTrustConfigs,
  loadConfig,
  trustConfigPath,
  updateTrustConfig,
} from "@claudexor/config";

export async function listTrustService(input?: {
  repoRoot?: string;
}): Promise<ControlTrustListResponse> {
  const repoRoot = input?.repoRoot;
  if (repoRoot && !isAbsolute(repoRoot)) throw badRoot(repoRoot);
  if (repoRoot) {
    const config = loadConfig(repoRoot);
    return ControlTrustListResponse.parse({
      entries: [
        {
          repoRoot,
          path: trustConfigPath(repoRoot),
          allowFullAccess: config.trust.allow_full_access,
          accessDefault: config.trust.access_default,
        },
      ],
    });
  }
  return ControlTrustListResponse.parse({
    entries: listTrustConfigs().map(({ path, config }) => ({
      repoRoot: config.repo_root,
      path,
      allowFullAccess: config.allow_full_access,
      accessDefault: config.access_default,
    })),
  });
}

export async function updateTrustService(
  input: ControlTrustUpdateRequest,
): Promise<ControlTrustState> {
  if (!isAbsolute(input.repoRoot)) throw badRoot(input.repoRoot);
  const res = updateTrustConfig(input.repoRoot, (cfg) => ({
    ...cfg,
    ...(input.allowFullAccess === undefined ? {} : { allow_full_access: input.allowFullAccess }),
    ...(input.accessDefault === undefined ? {} : { access_default: input.accessDefault }),
  }));
  return ControlTrustState.parse({
    repoRoot: res.config.repo_root,
    path: res.path,
    allowFullAccess: res.config.allow_full_access,
    accessDefault: res.config.access_default,
  });
}

function badRoot(repoRoot: string): Error & { status: number } {
  return Object.assign(new Error(`repoRoot must be an absolute path (got ${repoRoot})`), {
    status: 400,
  });
}
