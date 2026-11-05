import { join } from "node:path";
import { userConfigDir } from "./index.js";

/**
 * The engine-owned namespace of explicitly ephemeral one-shot runs (#503): run
 * trees keyed by run id under `runs/`, their adjacent envelopes under
 * `workspaces/`. A new temporary cwd therefore never gets a persistent
 * `projects/<sha256>` namespace for its runs; root-keyed Git object stores and
 * anchors keep their own owners and locks.
 */
export function oneShotRuntimeDir(): string {
  return join(userConfigDir(), "one-shot");
}

export interface GlobalRunStore {
  /** `ask`: folderless no-project Ask; `one_shot`: explicitly ephemeral roots. */
  kind: "ask" | "one_shot";
  /** The store's runtime directory (`ArtifactStore.claudexorDir`). */
  runtime: string;
  runsDir: string;
}

/**
 * The run stores outside `projects/<sha256>/` (#503): the ONE list every reader
 * that enumerates run trees (retention, native session references, run lookup)
 * reads beside the project namespaces it already scans. The Ask store's runtime
 * is the config root itself, so nothing may treat it as a removable namespace.
 */
export function globalRunStores(): GlobalRunStore[] {
  const askRuntime = userConfigDir();
  const oneShot = oneShotRuntimeDir();
  return [
    { kind: "ask", runtime: askRuntime, runsDir: join(askRuntime, "runs") },
    { kind: "one_shot", runtime: oneShot, runsDir: join(oneShot, "runs") },
  ];
}
