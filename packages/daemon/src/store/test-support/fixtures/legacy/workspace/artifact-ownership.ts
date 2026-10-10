import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  CLAUDEXOR_ARTIFACT_DIR,
  claudexorArtifactRunDirectory,
  WorkspaceError,
} from "../core/index.js";
import type { WorkspaceEnvelope } from "../schema/index.js";

interface ArtifactOwnershipMarker {
  version: 1;
  envelope_id: string;
  relative_path: string;
  root_created: boolean;
}

/** Owns the lifecycle of one marker-bound browser-artifact child. */
export class ArtifactOwnership {
  constructor(private readonly markerPathFor: (env: WorkspaceEnvelope) => string) {}

  private marker(env: WorkspaceEnvelope): ArtifactOwnershipMarker | null {
    try {
      const parsed = JSON.parse(
        readFileSync(this.markerPathFor(env), "utf8"),
      ) as Partial<ArtifactOwnershipMarker>;
      const relative = claudexorArtifactRunDirectory(env.id);
      if (
        parsed.version !== 1 ||
        parsed.envelope_id !== env.id ||
        parsed.relative_path !== relative ||
        typeof parsed.root_created !== "boolean"
      ) {
        return null;
      }
      return parsed as ArtifactOwnershipMarker;
    } catch {
      return null;
    }
  }

  /** Lazily reserve the one run-owned artifact subtree. A pre-existing shared
   * root is ordinary user state; only this marker-bound child is excluded,
   * collected, and cleaned. */
  ensureDirectory(env: WorkspaceEnvelope): string {
    const relative = claudexorArtifactRunDirectory(env.id);
    const root = join(env.worktree_path, CLAUDEXOR_ARTIFACT_DIR);
    const path = join(env.worktree_path, relative);
    const marker = this.marker(env);
    if (marker) {
      this.ensureSafeRoot(root);
      if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new WorkspaceError("owned artifact path is no longer a private directory");
      }
      return path;
    }

    let rootCreated = false;
    try {
      mkdirSync(root, { mode: 0o700 });
      rootCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    this.ensureSafeRoot(root);
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (rootCreated) {
        try {
          rmdirSync(root);
        } catch {
          /* preserve a raced/non-empty root */
        }
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new WorkspaceError("owned artifact path unexpectedly already exists");
      }
      throw error;
    }
    const ownership: ArtifactOwnershipMarker = {
      version: 1,
      envelope_id: env.id,
      relative_path: relative,
      root_created: rootCreated,
    };
    try {
      writeFileSync(this.markerPathFor(env), `${JSON.stringify(ownership)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      rmSync(path, { recursive: true, force: true });
      if (rootCreated) {
        try {
          rmdirSync(root);
        } catch {
          /* preserve a raced/non-empty root */
        }
      }
      throw error;
    }
    return path;
  }

  relativeDirectory(env: WorkspaceEnvelope): string | null {
    return this.marker(env)?.relative_path ?? null;
  }

  private ensureSafeRoot(root: string): void {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new WorkspaceError("shared artifact root is not a real directory");
    }
  }

  removeDirectory(env: WorkspaceEnvelope): void {
    const marker = this.marker(env);
    if (!marker) return;
    const root = join(env.worktree_path, CLAUDEXOR_ARTIFACT_DIR);
    const path = join(env.worktree_path, marker.relative_path);
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* best-effort: never broaden cleanup beyond the marker-bound child */
    }
    if (!marker.root_created) return;
    try {
      const stat = lstatSync(root);
      if (stat.isDirectory() && !stat.isSymbolicLink() && readdirSync(root).length === 0) {
        rmdirSync(root);
      }
    } catch {
      /* preserve a missing, replaced, raced, or non-empty shared root */
    }
  }
}
