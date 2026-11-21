import { isEphemeralRunScope } from "@claudexor/schema";
import { compareFolder } from "../projects.js";
import type { BlobFiles } from "./blob-files.js";
import { SERVED_PIDS_SQL } from "./generations.js";
import type { MutationContext } from "./mutation.js";
import type { PartitionGeneration } from "./partitions.js";

/** The one live-holder survey behind the bound release fence: whether accepted
 * work still uses a registration's folder, decided inside the same SQL
 * transaction that would archive it. */
export interface RegistrationHolderSurvey {
  /** The registration's own served generation: its live commands and reserved
   * slots are the folder's own work, whatever folder facts they record. */
  partition: PartitionGeneration;
  /** The registration's recorded canonical root — the one comparison's anchor. */
  root: string;
  /** Engine-owned bytes of reserved drafts' captured starts. */
  blobs: Pick<BlobFiles, "read">;
}

/** True while accepted work still uses this registration's folder.
 *
 * The folder's own served generation holds it through any live command or any
 * waiting/held reserved slot: partition membership is the accounting tie, so a
 * recorded spelling never has to match to count. Across the served generations,
 * a live command holds it through the folder addresses it recorded — the
 * explicit execution workspace of a project-scoped delegated run, or the root a
 * one-off (`ephemeral`) project scope anchors. A reserved draft can still start,
 * so its captured start is read the same way; but only in a served generation —
 * a retired generation cannot dispatch, so its slot is not a live holder.
 *
 * `unknown` always holds: recorded facts that cannot be read are not absence of
 * usage, and a folder the one comparison does not prove `different` is still
 * one the work may be in. A NAMED project's scope is a registry key, never a
 * workspace fact, so it is deliberately never compared (a historical spelling
 * must not decide another registration's release). Both reads walk the
 * live/reserved partial indexes only, never history. */
export function registrationInUseInTx(
  tx: MutationContext,
  { partition, root, blobs }: RegistrationHolderSurvey,
): boolean {
  if (
    tx
      .prepare(
        "SELECT 1 FROM command WHERE live=1 AND state IN ('queued','running') AND pid=? LIMIT 1",
      )
      .get(partition.pid) ||
    tx
      .prepare(
        "SELECT 1 FROM deferred_message WHERE state IN ('waiting','held') AND pid=? LIMIT 1",
      )
      .get(partition.pid)
  )
    return true;
  const commands = tx
    .prepare("SELECT summary FROM command WHERE live=1 AND state IN ('queued','running')")
    .all() as Array<{ summary: Uint8Array }>;
  for (const command of commands) {
    const folders = commandRecordedFolders(command.summary);
    if (folders === null || folders.some((folder) => compareFolder(folder, root) !== "different"))
      return true;
  }
  const drafts = tx
    .prepare(
      `SELECT body_sha FROM deferred_message WHERE state IN ('waiting','held')
      AND body_sha IS NOT NULL AND pid IN (${SERVED_PIDS_SQL})`,
    )
    .all() as Array<{ body_sha: string }>;
  for (const draft of drafts) {
    const folders = draftRecordedFolders(blobs, draft.body_sha);
    if (folders === null || folders.some((folder) => compareFolder(folder, root) !== "different"))
      return true;
  }
  return false;
}

/** The folder addresses one live command recorded in its accepted summary:
 * `params.execution.workspaceRoot` and a one-off scope's root. `null` when the
 * recorded bytes cannot be read at all — the caller holds. */
export function commandRecordedFolders(summary: Uint8Array): string[] | null {
  try {
    const parsed = JSON.parse(Buffer.from(summary).toString("utf8")) as {
      params?: { scope?: unknown; execution?: { workspaceRoot?: unknown } };
    };
    return recordedFolders(parsed.params?.scope, parsed.params?.execution?.workspaceRoot);
  } catch {
    return null;
  }
}

/** The same, read from a reserved draft's captured start bytes (the engine's
 * own body blob); an unreadable body is `null` too, never "no workspace fact". */
export function draftRecordedFolders(
  blobs: Pick<BlobFiles, "read">,
  bodySha: string,
): string[] | null {
  try {
    const body = JSON.parse(blobs.read(bodySha).toString("utf8")) as {
      capturedStart?: { scope?: unknown; execution?: { workspaceRoot?: unknown } } | null;
    };
    return recordedFolders(
      body.capturedStart?.scope,
      body.capturedStart?.execution?.workspaceRoot,
    );
  } catch {
    return null;
  }
}

/** The folder addresses one accepted request records: the explicit execution
 * workspace, and the root a one-off project scope anchors. A one-off scope whose
 * declared root is missing is a fact this read cannot resolve — `null`, so the
 * caller holds. */
function recordedFolders(scope: unknown, workspaceRoot: unknown): string[] | null {
  const folders: string[] = [];
  if (isEphemeralRunScope(scope)) {
    const root = (scope as { root?: unknown }).root;
    if (typeof root !== "string" || !root) return null;
    folders.push(root);
  }
  if (typeof workspaceRoot === "string" && workspaceRoot) folders.push(workspaceRoot);
  return folders;
}
