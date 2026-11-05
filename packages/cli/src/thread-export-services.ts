/** Bind the one thread export producer to its store, adapter and purge owners. */
import { CONTINUITY_PROFILE_LOCATOR_ENV } from "@claudexor/core";
import { loadConfig } from "@claudexor/config";
import {
  createThreadExport,
  type NativeLayout,
  type NativeStoreRef,
  type ThreadExportClosure,
} from "@claudexor/control-api";
import {
  retirementRefusal,
  type ProjectThreadPort,
  type ResourceStorePort,
} from "@claudexor/daemon";
import type { Thread } from "@claudexor/schema";
import { noProjectRepoRoot, ownedProjectRuntimeDir } from "@claudexor/util";
import { threadWorktreeDirExists } from "@claudexor/workspace";
import { buildRegistry } from "./registry.js";

const NO_PROJECT_ROOT = noProjectRepoRoot();
// Fake sessions are a test double's, keyed by the fake's own explicit ids. A lane
// walk asks once per file, and these declarations do not change within a process.
let registry: ReturnType<typeof buildRegistry> | undefined;
const adapters = () => (registry ??= buildRegistry({ includeFakes: true }));

/** A lane is `<harness>-<profile>`; its adapter names the lane's credential stores. */
export function laneCredentialStores(laneSegment: string): readonly string[] | null {
  let found: { id: string; stores: readonly string[] | null } | null = null;
  for (const [id, adapter] of adapters())
    if (laneSegment.startsWith(`${id}-`) && (!found || id.length > found.id.length))
      found = { id, stores: adapter.nativeSessionExport?.laneCredentialStores ?? null };
  return found?.stores ?? null;
}

function nativeLayout(harness: string): NativeLayout | null {
  const declared = adapters().get(harness)?.nativeSessionExport;
  if (!declared) return null;
  const stores: NativeStoreRef[] = [];
  const unresolved: { storeKey: string; message: string }[] = [];
  const add = (storeKey: string, profileId: string | null, env: Record<string, string>): void => {
    // A store its adapter refuses to resolve may still hold a session: name it.
    // No root at all (a fake with no fixture store) is no store.
    try {
      const root = declared.storeRoot(env);
      if (root) stores.push({ storeKey, profileId, root });
    } catch (error) {
      unresolved.push({
        storeKey,
        message: `store cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };
  add("default", null, {});
  for (const profile of loadConfig(NO_PROJECT_ROOT).global.credential_profiles)
    if (
      profile.harness_id === harness &&
      profile.credential_kind === "config_dir_login" &&
      profile.isolation_locator
    )
      add(`profile-${profile.profile_id}`, profile.profile_id, {
        [CONTINUITY_PROFILE_LOCATOR_ENV]: profile.isolation_locator,
      });
  return {
    stores,
    unresolved,
    sessionLocations: declared.sessionLocations,
    evidence: declared.formatEvidence,
    outOfClosure: declared.outOfClosure,
  };
}

const rootOf = (thread: ThreadExportClosure["thread"]): string =>
  thread.repo?.root ?? NO_PROJECT_ROOT;

export function threadExportService(
  threads: ProjectThreadPort,
  resources: Pick<ResourceStorePort, "resolve">,
  finishPurge: (thread: Thread, signal?: AbortSignal) => Promise<void>,
  hasPurgeLeftovers: (thread: Thread) => boolean,
) {
  return createThreadExport({
    thread: (id) => threads.threadRecord(id),
    closure: (id, signal) => threads.threadClosure(id, signal),
    document: (id, key) => threads.threadClosureDocument(id, key),
    nativeLayout,
    laneCredentialStores,
    laneDirectory: (thread) => ownedProjectRuntimeDir(rootOf(thread), "lanes", thread.id),
    isolatedWorktreeExists: (thread) =>
      thread.workspace.worktree_path !== null || threadWorktreeDirExists(rootOf(thread), thread.id),
    resolveAttachments: (refs, heldBy) => resources.resolve(refs, heldBy),
    retire: (id, request, acceptedLane) => threads.retireThread(id, request, acceptedLane),
    operation: (id, operationId) => threads.retirementOperation(id, operationId),
    settle: (id, operationId, refusal) =>
      threads.settleRetirement(
        id,
        operationId,
        refusal ? retirementRefusal(refusal.code, refusal.message) : null,
      ),
    finishPurge: (thread, signal) => finishPurge(thread as Thread, signal),
    cleanup: (id) => threads.threadCleanup(id),
    hasPurgeLeftovers: (thread) => hasPurgeLeftovers(thread as Thread),
  });
}
