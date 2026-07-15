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
import { buildTestCommandGrant } from "@claudexor/review";
import { canonicalProjectRoot, hashJson, sha256 } from "@claudexor/util";

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
          testCommandGrantCount: config.trust.test_command_grants.length,
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
      testCommandGrantCount: config.test_command_grants.length,
    })),
  });
}

export async function updateTrustService(
  input: ControlTrustUpdateRequest,
): Promise<ControlTrustState> {
  if (!isAbsolute(input.repoRoot)) throw badRoot(input.repoRoot);
  const current = loadConfig(input.repoRoot);
  const grant = input.grantTestCommand
    ? buildTestCommandGrant(input.grantTestCommand, input.repoRoot, {
        projectDigest: sha256(canonicalProjectRoot(input.repoRoot)),
        configDigest: hashJson(current.project),
        accessProfile: input.grantAccessProfile ?? current.trust.access_default,
      })
    : null;
  const res = updateTrustConfig(input.repoRoot, (cfg) => ({
    ...cfg,
    ...(input.allowFullAccess === undefined ? {} : { allow_full_access: input.allowFullAccess }),
    ...(input.accessDefault === undefined ? {} : { access_default: input.accessDefault }),
    test_command_grants: [
      ...cfg.test_command_grants.filter(
        (existing) =>
          existing.commandDigest !== input.revokeTestCommandDigest &&
          (!grant || existing.commandDigest !== grant.commandDigest),
      ),
      ...(grant ? [grant] : []),
    ],
  }));
  return ControlTrustState.parse({
    repoRoot: res.config.repo_root,
    path: res.path,
    allowFullAccess: res.config.allow_full_access,
    accessDefault: res.config.access_default,
    testCommandGrantCount: res.config.test_command_grants.length,
  });
}

function badRoot(repoRoot: string): Error & { status: number } {
  return Object.assign(new Error(`repoRoot must be an absolute path (got ${repoRoot})`), {
    status: 400,
  });
}
